from __future__ import annotations

import json
import re
import socket
import ssl
import struct
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

import requests
from dotenv import load_dotenv
from pypdf import PdfReader

from deepxiv_sdk import Reader
from deepxiv_sdk.cli import DEFAULT_DAILY_LIMIT, SDK_REGISTER_ENDPOINT, ensure_token, generate_registration_payload, get_token, save_token

OPENALEX_WORKS_URL = "https://api.openalex.org/works"
EUROPEPMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
EUROPEPMC_ARTICLE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/article/{source}/{id}"
HTTP_TIMEOUT = 30

SOURCE_PRIORITY = {
    "arxiv": 0,
    "openalex": 1,
    "pubmed": 2,
    "pmc": 3,
    "preprint": 4,
    "europepmc": 5,
    "local-pdf": 6,
}


def configure_stdio_encoding() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if not stream:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if not reconfigure:
            continue
        try:
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass


configure_stdio_encoding()


def load_env() -> None:
    load_dotenv(Path.home() / ".env", override=False)
    load_dotenv(Path.cwd() / ".env", override=False)


def current_token() -> Optional[str]:
    load_env()
    return get_token(None)


def ensure_home_dir() -> None:
    Path.home().mkdir(parents=True, exist_ok=True)


def token_summary() -> Dict[str, Any]:
    token = current_token()
    masked = "未配置"
    if token:
        masked = token if len(token) <= 10 else f"{token[:6]}...{token[-4:]}"
    return {"has_token": bool(token), "token": token or "", "masked": masked}


def simplify_registration_error(message: str) -> str:
    text = normalize_spaces(message)
    if not text:
        return "匿名注册失败，请稍后重试"
    lowered = text.lower()
    if "failed to resolve" in lowered or "nameresolutionerror" in lowered or "nodename nor servname provided" in lowered:
        return "匿名注册服务当前无法解析，请检查网络连接后重试"
    if "max retries exceeded" in lowered or "httpsconnectionpool" in lowered or "connection aborted" in lowered:
        return "匿名注册服务当前不可达，请稍后重试"
    if "timed out" in lowered or "timeout" in lowered:
        return "匿名注册请求超时，请稍后重试"
    return "匿名注册失败，请稍后重试"


def read_dns_name_end(payload: bytes, offset: int) -> int:
    while True:
        if offset >= len(payload):
            raise ValueError("DNS 响应格式异常")
        length = payload[offset]
        if length == 0:
            return offset + 1
        if length & 0xC0 == 0xC0:
            return offset + 2
        offset += 1 + length


def build_dns_query(host: str, query_id: int = 0x2D58) -> bytes:
    header = struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0)
    labels = b"".join(len(part).to_bytes(1, "big") + part.encode("utf-8") for part in host.split(".")) + b"\x00"
    return header + labels + struct.pack("!HH", 1, 1)


def parse_dns_response(payload: bytes, query_id: int = 0x2D58) -> List[str]:
    if len(payload) < 12:
        raise ValueError("DNS 响应过短")
    response_id, _flags, question_count, answer_count, _authority_count, _additional_count = struct.unpack("!HHHHHH", payload[:12])
    if response_id != query_id:
        raise ValueError("DNS 响应 ID 不匹配")
    offset = 12
    for _ in range(question_count):
        offset = read_dns_name_end(payload, offset)
        offset += 4
    results: List[str] = []
    for _ in range(answer_count):
        offset = read_dns_name_end(payload, offset)
        if offset + 10 > len(payload):
            raise ValueError("DNS Answer 结构不完整")
        answer_type, answer_class, _ttl, data_length = struct.unpack("!HHIH", payload[offset:offset + 10])
        offset += 10
        if offset + data_length > len(payload):
            raise ValueError("DNS Answer 数据不完整")
        data = payload[offset:offset + data_length]
        offset += data_length
        if answer_type == 1 and answer_class == 1 and data_length == 4:
            results.append(".".join(str(part) for part in data))
    return results


def resolve_ipv4_via_public_dns(host: str) -> List[str]:
    last_error: Optional[Exception] = None
    query_id = 0x2D58
    query = build_dns_query(host, query_id)
    for resolver in ("223.5.5.5", "1.1.1.1", "8.8.8.8"):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(3)
        try:
            sock.sendto(query, (resolver, 53))
            payload, _ = sock.recvfrom(2048)
            results = parse_dns_response(payload, query_id)
            if results:
                return results
        except Exception as exc:
            last_error = exc
        finally:
            sock.close()
    raise RuntimeError(f"公共 DNS 解析失败: {last_error}")


def decode_chunked_http(body: bytes) -> bytes:
    offset = 0
    chunks = []
    while True:
        line_end = body.find(b"\r\n", offset)
        if line_end < 0:
            raise ValueError("Chunked 响应格式异常")
        size_text = body[offset:line_end].split(b";", 1)[0].strip()
        size = int(size_text or b"0", 16)
        offset = line_end + 2
        if size == 0:
            return b"".join(chunks)
        chunk = body[offset:offset + size]
        chunks.append(chunk)
        offset += size + 2


def read_http_response(sock: ssl.SSLSocket) -> tuple[int, Dict[str, str], bytes]:
    chunks = []
    while True:
        data = sock.recv(4096)
        if not data:
            break
        chunks.append(data)
    raw = b"".join(chunks)
    header_bytes, _, body = raw.partition(b"\r\n\r\n")
    if not header_bytes:
        raise ValueError("HTTP 响应头缺失")
    header_text = header_bytes.decode("iso-8859-1", errors="replace")
    lines = header_text.split("\r\n")
    status_line = lines[0].split()
    status_code = int(status_line[1]) if len(status_line) > 1 else 0
    headers: Dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = decode_chunked_http(body)
    return status_code, headers, body


def register_token_via_resolved_ip(payload: Dict[str, Any]) -> Dict[str, Any]:
    endpoint = urlsplit(SDK_REGISTER_ENDPOINT)
    host = endpoint.hostname or "data.rag.ac.cn"
    port = endpoint.port or 443
    path = endpoint.path or "/api/register/sdk"
    if endpoint.query:
        path = f"{path}?{endpoint.query}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last_error: Optional[Exception] = None
    for ip in resolve_ipv4_via_public_dns(host):
        try:
            with socket.create_connection((ip, port), timeout=15) as tcp_sock:
                context = ssl.create_default_context()
                with context.wrap_socket(tcp_sock, server_hostname=host) as tls_sock:
                    request = (
                        f"POST {path} HTTP/1.1\r\n"
                        f"Host: {host}\r\n"
                        "User-Agent: DeepXiv-Desktop/1.0\r\n"
                        "Accept: application/json\r\n"
                        "Content-Type: application/json\r\n"
                        f"Content-Length: {len(body)}\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode("utf-8")
                    tls_sock.sendall(request + body)
                    status_code, _headers, response_body = read_http_response(tls_sock)
            if status_code >= 400:
                raise RuntimeError(f"HTTP {status_code}")
            return json.loads(response_body.decode("utf-8", errors="replace"))
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"匿名注册服务当前不可达: {last_error}")


def perform_sdk_registration(payload: Dict[str, Any]) -> Dict[str, Any]:
    response = requests.post(SDK_REGISTER_ENDPOINT, json=payload, timeout=30)
    response.raise_for_status()
    return response.json()


def register_token() -> Dict[str, Any]:
    ensure_home_dir()
    payload = generate_registration_payload()
    try:
        result = perform_sdk_registration(payload)
    except requests.exceptions.RequestException as primary_error:
        try:
            result = register_token_via_resolved_ip(payload)
        except Exception as fallback_error:
            raise RuntimeError(simplify_registration_error(f"{primary_error}; {fallback_error}"))
    except ValueError as exc:
        raise RuntimeError("匿名注册服务返回了无法解析的数据") from exc

    if not result.get("success"):
        raise RuntimeError(normalize_spaces(result.get("message")) or "匿名注册失败，请稍后重试")

    data = result.get("data", {})
    token = str(data.get("token") or "").strip()
    daily_limit = data.get("daily_limit", DEFAULT_DAILY_LIMIT)
    if not token:
        raise RuntimeError("匿名注册成功，但服务未返回 token")

    save_token(token, is_global=True)
    summary = token_summary()
    summary["daily_limit"] = daily_limit
    return summary


def save_manual_token(token: str) -> Dict[str, Any]:
    token = token.strip()
    if not token:
        raise ValueError("请输入有效 Token")
    ensure_home_dir()
    save_token(token, is_global=True)
    return token_summary()


def make_reader() -> Reader:
    token = ensure_token(None)
    return Reader(token=token, timeout=60, max_retries=2, retry_delay=1.0)


def http_get_json(url: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    query = urlencode({key: value for key, value in (params or {}).items() if value not in (None, "")}, doseq=True)
    full_url = f"{url}?{query}" if query else url
    request = Request(full_url, headers={"User-Agent": "DeepXiv-Mac-Client/1.0"})
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip()
        raise RuntimeError(detail or f"请求失败：HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError(f"网络请求失败：{exc.reason}") from exc


def parse_publish_time(value: Any) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    for candidate in (text, text.replace("Z", "+00:00"), f"{text}-01-01"):
        try:
            return datetime.fromisoformat(candidate).timestamp()
        except ValueError:
            continue
    return 0.0


def normalize_doi(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text, flags=re.IGNORECASE)
    match = re.search(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", text, re.IGNORECASE)
    return match.group(0).lower() if match else text.lower()


def normalize_title_key(value: Any) -> str:
    return re.sub(r"\W+", " ", str(value or "").strip().lower()).strip()


def extract_arxiv_id(text: str) -> str:
    match = re.search(r"(?:arxiv\.org/(?:abs|pdf|html)/)?([a-z\-]+/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?", text, re.IGNORECASE)
    return match.group(1) if match else ""


def extract_openalex_id(text: str) -> str:
    value = str(text or "").strip()
    if re.fullmatch(r"W\d+", value, re.IGNORECASE):
        return value.upper()
    match = re.search(r"openalex\.org/(W\d+)", value, re.IGNORECASE)
    return match.group(1).upper() if match else ""


def build_paper_key(source_kind: str, paper_id: str, fallback: str) -> str:
    seed = paper_id or fallback or "paper"
    return f"{source_kind}:{seed}"


def normalize_spaces(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def is_remote_http_url(url: str) -> bool:
    return bool(re.match(r"^https?://", str(url or "").strip(), re.IGNORECASE))


def local_pdf_key(file_path: Path) -> str:
    return build_paper_key("local-pdf", str(file_path), file_path.stem)


def clean_pdf_lines(text: str) -> List[str]:
    lines: List[str] = []
    for raw in str(text or "").splitlines():
        line = normalize_spaces(raw)
        if not line:
            continue
        lines.append(line)
    return lines


def looks_like_generic_pdf_title(value: str, file_stem: str) -> bool:
    lowered = normalize_spaces(value).lower()
    if not lowered:
        return True
    generic_markers = {
        "untitled",
        "article",
        "paper",
        "document",
        "default",
        "microsoft word",
        "latex2e",
        normalize_spaces(file_stem).lower(),
    }
    return lowered in generic_markers


def looks_like_author_line(line: str) -> bool:
    text = normalize_spaces(line)
    lowered = text.lower()
    if "@" in text or "university" in lowered or "department" in lowered or "institute" in lowered:
        return False
    if len(text.split()) > 24:
        return False
    if "," in text:
        return True
    if " and " in lowered and sum(part[:1].isupper() for part in text.split()) >= 2:
        return True
    return False


def looks_like_affiliation_line(line: str) -> bool:
    text = normalize_spaces(line)
    lowered = text.lower()
    if not text:
        return False
    affiliation_keywords = (
        "university",
        "department",
        "school of",
        "college of",
        "institute",
        "laboratory",
        "laboratories",
        "lab ",
        " lab",
        "hospital",
        "centre",
        "center",
        "academy",
        "faculty",
        "research group",
        "research center",
        "research centre",
        "street",
        "road",
        "avenue",
        "beijing",
        "shanghai",
        "china",
        "usa",
        "uk",
    )
    if any(keyword in lowered for keyword in affiliation_keywords):
        return True
    if "@" in text or "orcid" in lowered or "http" in lowered or "www." in lowered:
        return True
    if re.search(r"\b(corresponding author|equal contribution|work done while|contact|email)\b", lowered):
        return True
    if re.search(r"\b\d{5,}\b", text) and len(text.split()) <= 20:
        return True
    return False


def looks_like_metadata_noise(line: str) -> bool:
    text = normalize_spaces(line)
    lowered = text.lower()
    if not text:
        return True
    if looks_like_author_line(text) or looks_like_affiliation_line(text):
        return True
    if re.match(r"^(received|accepted|published|submitted|preprint|copyright|licensed under|arxiv:)\b", lowered):
        return True
    if re.fullmatch(r"[\W\d]+", text):
        return True
    return False


def strip_abstract_heading(text: str) -> str:
    return normalize_spaces(re.sub(r"^abstract\s*[:\-—–]?\s*", "", str(text or "").strip(), flags=re.IGNORECASE))


def clean_abstract_text(text: str, title: str = "", author_line: str = "") -> str:
    value = normalize_spaces(text)
    if not value:
        return ""
    for marker in (normalize_spaces(title), normalize_spaces(author_line)):
        if marker and value.lower().startswith(marker.lower()):
            value = normalize_spaces(value[len(marker):])
    value = strip_abstract_heading(value)
    value = re.split(r"\b(?:\d+(?:\.\d+){0,2}|[IVXLCM]+)\s+(?:Introduction|Background|Related Work|Method(?:s)?|Approach|Experiment(?:s)?|Results|Discussion|Conclusion(?:s)?)\b", value, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    value = re.split(r"\b(?:keywords|index terms|introduction|references)\b", value, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    value = re.sub(r"(?:^|\s)(?:\d+(?:\.\d+){0,2}|[IVXLCM]+)\s*$", "", value, flags=re.IGNORECASE).strip()
    return normalize_spaces(value)


def looks_like_valid_abstract(text: str, title: str = "", author_line: str = "") -> bool:
    value = clean_abstract_text(text, title, author_line)
    lowered = value.lower()
    if len(value) < 80:
        return False
    if looks_like_metadata_noise(value):
        return False
    if any(keyword in lowered for keyword in ("university", "department", "institute", "hospital", "@")):
        return False
    if value.count(",") >= 4 and "." not in value and "。" not in value:
        return False
    return True


def looks_like_title_line(line: str) -> bool:
    text = normalize_spaces(line)
    lowered = text.lower()
    if len(text) < 12 or len(text) > 220:
        return False
    if text.endswith(":"):
        return False
    if "@" in text or "http" in lowered or "www." in lowered:
        return False
    if re.fullmatch(r"[\d\W]+", text):
        return False
    if re.match(r"^(abstract|introduction|keywords|index terms|references|appendix)\b", lowered):
        return False
    if re.match(r"^(arxiv|submitted|accepted|published|conference|proceedings)\b", lowered):
        return False
    if looks_like_author_line(text):
        return False
    alpha_count = sum(char.isalpha() for char in text)
    return alpha_count >= 8


def extract_pdf_title(metadata_title: str, first_page_text: str, file_path: Path) -> str:
    title = normalize_spaces(metadata_title)
    if title and not looks_like_generic_pdf_title(title, file_path.stem):
        return title

    lines = clean_pdf_lines(first_page_text)
    candidates: List[tuple[int, int, str]] = []
    for index, line in enumerate(lines[:24]):
        if not looks_like_title_line(line):
            continue
        score = 0
        word_count = len(line.split())
        if 4 <= word_count <= 20:
            score += 4
        if index <= 5:
            score += 4 - index
        if not line.endswith("."):
            score += 1
        if re.search(r"[A-Za-z]{4,}", line):
            score += 1
        candidates.append((score, index, line))

    if not candidates:
        return file_path.stem

    _, start_index, first_line = sorted(candidates, reverse=True)[0]
    title_lines = [first_line]
    for next_line in lines[start_index + 1:start_index + 4]:
        if not looks_like_title_line(next_line):
            break
        if looks_like_author_line(next_line):
            break
        if len(normalize_spaces(" ".join([*title_lines, next_line])).split()) > 28:
            break
        title_lines.append(next_line)
    return normalize_spaces(" ".join(title_lines))


def extract_pdf_author_line(first_page_text: str, title: str) -> str:
    lines = clean_pdf_lines(first_page_text)
    title_text = normalize_spaces(title)
    try:
        start_index = lines.index(title_text)
    except ValueError:
        start_index = 0
    for line in lines[start_index + 1:start_index + 8]:
        lowered = line.lower()
        if re.match(r"^(abstract|introduction|keywords|index terms)\b", lowered):
            break
        if looks_like_author_line(line):
            return line
    return ""


def extract_pdf_abstract(full_text: str, title: str = "", author_line: str = "") -> str:
    text = str(full_text or "")
    lines = clean_pdf_lines(text)

    for index, line in enumerate(lines):
        lowered = line.lower()
        if not re.match(r"^abstract\b", lowered):
            continue

        collected: List[str] = []
        inline_text = strip_abstract_heading(line)
        if inline_text:
            collected.append(inline_text)

        for next_line in lines[index + 1:index + 18]:
            next_lowered = next_line.lower()
            if re.match(r"^(keywords|index terms|references|appendix)\b", next_lowered):
                break
            if looks_like_section_heading(next_line):
                break
            if looks_like_metadata_noise(next_line):
                continue
            collected.append(next_line)
            if len(normalize_spaces(" ".join(collected))) >= 2200:
                break

        candidate = clean_abstract_text(" ".join(collected), title, author_line)
        if looks_like_valid_abstract(candidate, title, author_line):
            return candidate[:2200]

    match = re.search(
        r"\babstract\b\s*[:\-—–]?\s*(.+?)(?=(?:\bkeywords\b|\bindex terms\b|\b1\s+introduction\b|\bintroduction\b|\bcontents\b|\b1\.\b)|$)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match:
        candidate = clean_abstract_text(match.group(1), title, author_line)
        if looks_like_valid_abstract(candidate, title, author_line):
            return candidate[:2200]

    if not lines:
        return ""
    joined = clean_abstract_text(" ".join(line for line in lines[:18] if not looks_like_metadata_noise(line)), title, author_line)
    return joined[:1200] if looks_like_valid_abstract(joined, title, author_line) else ""


def extract_pdf_lead_summary(first_page_text: str, title: str, author_line: str) -> str:
    lines = clean_pdf_lines(first_page_text)
    if not lines:
        return ""

    title_text = normalize_spaces(title)
    author_text = normalize_spaces(author_line)
    start_index = 0
    for index, line in enumerate(lines):
        if title_text and normalize_spaces(line) == title_text:
            start_index = index + 1
            break

    if author_text:
        for index, line in enumerate(lines[start_index:], start=start_index):
            if normalize_spaces(line) == author_text:
                start_index = index + 1
                break

    collected: List[str] = []
    for line in lines[start_index:start_index + 18]:
        lowered = line.lower()
        if re.match(r"^(keywords|index terms|references|contents)\b", lowered):
            break
        if looks_like_metadata_noise(line):
            continue
        if looks_like_section_heading(line):
            if collected:
                break
            continue
        if len(line) < 24:
            continue
        collected.append(line)
        if len(normalize_spaces(" ".join(collected))) >= 900:
            break
    return clean_abstract_text(" ".join(collected), title, author_line)[:1200]


COMMON_SECTION_HEADINGS = {
    "introduction",
    "background",
    "related work",
    "preliminaries",
    "method",
    "methods",
    "approach",
    "model",
    "models",
    "algorithm",
    "algorithms",
    "experiments",
    "experimental setup",
    "results",
    "discussion",
    "conclusion",
    "conclusions",
    "limitations",
    "appendix",
}


def looks_like_section_heading(line: str) -> bool:
    text = normalize_spaces(line)
    lowered = text.lower()
    if len(text) < 3 or len(text) > 120:
        return False
    if looks_like_author_line(text):
        return False
    if looks_like_generic_pdf_title(text, text):
        return False
    if re.match(r"^(abstract|keywords|index terms|references|acknowledg(?:e)?ments?)\b", lowered):
        return True
    if lowered in COMMON_SECTION_HEADINGS:
        return True
    if re.match(r"^(?:\d+(?:\.\d+){0,2}|[IVXLCM]+)[\.)]?\s+[A-Za-z].{1,100}$", text, re.IGNORECASE):
        return True
    alpha_count = sum(char.isalpha() for char in text)
    if text.isupper() and 1 <= len(text.split()) <= 8 and alpha_count >= 6:
        return True
    return False


def normalize_section_name(line: str) -> str:
    text = normalize_spaces(line)
    text = re.sub(r"^(?:\d+(?:\.\d+){0,2}|[IVXLCM]+)[\.)]?\s+", "", text, flags=re.IGNORECASE)
    if text.isupper():
        text = text.title()
    return text


def extract_pdf_sections(full_text: str) -> List[Dict[str, str]]:
    lines = clean_pdf_lines(full_text)
    if not lines:
        lines = []

    sections: List[Dict[str, str]] = []
    seen = set()
    for index, line in enumerate(lines):
        if not looks_like_section_heading(line):
            continue
        section_name = normalize_section_name(line)
        section_key = section_name.lower()
        if section_key in seen:
            continue
        if section_key in {"abstract", "keywords", "index terms", "references", "acknowledgments", "acknowledgements"}:
            continue

        preview_lines: List[str] = []
        for next_line in lines[index + 1:index + 12]:
            if looks_like_section_heading(next_line):
                break
            if len(next_line) < 18:
                continue
            preview_lines.append(next_line)
            if len(normalize_spaces(" ".join(preview_lines))) >= 220:
                break

        seen.add(section_key)
        sections.append({
            "name": section_name,
            "tldr": normalize_spaces(" ".join(preview_lines))[:240],
        })
        if len(sections) >= 12:
            break

    if sections:
        return sections

    cleaned = normalize_spaces(full_text)
    if not cleaned:
        return []

    pattern = re.compile(
        r"((?:\d+(?:\.\d+){0,2}|[IVXLCM]+)\s+(?:Introduction|Background|Related Work|Preliminaries|Method(?:s)?|Approach|Model(?:s)?|Algorithm(?:s)?|Experiment(?:s|al Setup)?|Results|Analysis|Discussion|Conclusion(?:s)?|Limitations|Appendix))",
        re.IGNORECASE,
    )
    matches = list(pattern.finditer(cleaned))
    for index, match in enumerate(matches):
        raw_name = match.group(1)
        name = normalize_section_name(raw_name)
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        body_start = match.end()
        body_end = matches[index + 1].start() if index + 1 < len(matches) else len(cleaned)
        snippet = normalize_spaces(cleaned[body_start:body_end])[:220]
        sections.append({"name": name, "tldr": snippet})
        if len(sections) >= 12:
            break
    return sections


def extract_contribution_points(abstract: str, full_text: str) -> List[str]:
    sentences = [
        normalize_spaces(item)
        for item in re.split(r"(?<=[。！？.!?])\s+", normalize_spaces(abstract or ""))
        if normalize_spaces(item)
    ]
    prioritized: List[str] = []
    others: List[str] = []
    seen = set()

    def push(bucket: List[str], value: str) -> None:
        normalized = normalize_spaces(value)
        if not normalized:
            return
        key = normalized.lower()
        if key in seen:
            return
        seen.add(key)
        bucket.append(normalized)

    keywords = (
        "we propose",
        "we present",
        "we introduce",
        "our method",
        "our approach",
        "our framework",
        "this paper",
        "results show",
        "we demonstrate",
        "we develop",
        "we design",
    )

    def is_good_contribution_sentence(sentence: str) -> bool:
        lowered = sentence.lower()
        if len(sentence) < 24:
            return False
        if looks_like_metadata_noise(sentence):
            return False
        if any(keyword in lowered for keyword in ("university", "department", "institute", "hospital", "@", "corresponding author")):
            return False
        return True

    for sentence in sentences:
        lowered = sentence.lower()
        if not is_good_contribution_sentence(sentence):
            continue
        if any(keyword in lowered for keyword in keywords):
            push(prioritized, sentence)
        else:
            push(others, sentence)

    points = (prioritized + others)[:4]
    if points:
        return points

    sections = extract_pdf_sections(full_text)
    if sections:
        return [item["name"] for item in sections[:4]]
    return []


def extract_pdf_context_excerpt(full_text: str, abstract: str) -> str:
    cleaned = normalize_spaces(full_text)
    if not cleaned:
        return abstract[:3000]
    if abstract and abstract in cleaned:
        return cleaned[:5000]
    return cleaned[:5000]


def parse_local_pdf(file_path_value: str) -> Dict[str, Any]:
    file_path = Path(str(file_path_value or "")).expanduser().resolve()
    if not file_path.exists():
        raise FileNotFoundError("未找到本地 PDF 文件")
    if file_path.suffix.lower() != ".pdf":
        raise ValueError("请选择 PDF 文件")

    reader = PdfReader(str(file_path))
    metadata = reader.metadata or {}
    page_texts: List[str] = []
    for page in reader.pages[:8]:
        try:
            page_texts.append(page.extract_text() or "")
        except Exception:
            continue
    first_page_text = page_texts[0] if page_texts else ""
    full_text = "\n".join(page_texts)

    title = extract_pdf_title(str(getattr(metadata, "title", "") or metadata.get("/Title") or ""), first_page_text, file_path)
    author_line = extract_pdf_author_line(first_page_text, title)
    abstract = extract_pdf_abstract(full_text, title, author_line)
    if not looks_like_valid_abstract(abstract, title, author_line):
        abstract = extract_pdf_lead_summary(first_page_text, title, author_line)
    abstract = clean_abstract_text(abstract, title, author_line)
    context_excerpt = extract_pdf_context_excerpt(full_text, abstract)
    sections = extract_pdf_sections(full_text)
    contribution_points = extract_contribution_points(abstract, full_text)
    created = str(getattr(metadata, "creation_date", "") or metadata.get("/CreationDate") or "").strip()

    result = {
        "paper_key": local_pdf_key(file_path),
        "favorite_key": local_pdf_key(file_path),
        "source_kind": "local-pdf",
        "source_label": "本地 PDF",
        "title": title or file_path.stem,
        "abstract": abstract,
        "author_line": author_line,
        "publish_at": created,
        "arxiv_id": "",
        "openalex_id": "",
        "europepmc_id": "",
        "europepmc_source": "",
        "external_url": str(file_path),
        "src_url": str(file_path),
        "pdf_url": "",
        "local_pdf_path": str(file_path),
        "supports_favorite": True,
        "full_context_text": context_excerpt,
        "contribution_points": contribution_points,
        "sections": sections,
    }
    return result


def paper_identity_key(item: Dict[str, Any]) -> str:
    doi = normalize_doi(item.get("doi"))
    if doi:
        return f"doi:{doi}"
    arxiv_id = str(item.get("arxiv_id") or "").strip()
    if arxiv_id:
        return f"arxiv:{arxiv_id.lower()}"
    openalex_id = str(item.get("openalex_id") or "").strip()
    if openalex_id:
        return f"openalex:{openalex_id.lower()}"
    europepmc_id = str(item.get("europepmc_id") or "").strip()
    europepmc_source = str(item.get("europepmc_source") or "").strip().upper()
    if europepmc_id and europepmc_source:
        return f"europepmc:{europepmc_source}:{europepmc_id.lower()}"
    title_key = normalize_title_key(item.get("title"))
    if title_key:
        return f"title:{title_key}"
    return str(item.get("paper_key") or "")


def source_group(item: Dict[str, Any]) -> str:
    source_kind = str(item.get("source_kind") or "").strip().lower()
    if source_kind in {"pubmed", "pmc", "preprint", "europepmc"}:
        return "europepmc"
    if source_kind in {"arxiv", "openalex"}:
        return source_kind
    if source_kind == "local-pdf":
        return "local-pdf"
    return source_kind or "other"


def to_author_line_from_names(values: List[str]) -> str:
    return ", ".join([name for name in values if name][:6])


def reconstruct_openalex_abstract(abstract_index: Any) -> str:
    if not isinstance(abstract_index, dict) or not abstract_index:
        return ""
    max_pos = -1
    for positions in abstract_index.values():
        if isinstance(positions, list) and positions:
            max_pos = max(max_pos, max(positions))
    if max_pos < 0:
        return ""
    words = [""] * (max_pos + 1)
    for token, positions in abstract_index.items():
        if not isinstance(positions, list):
            continue
        for pos in positions:
            if isinstance(pos, int) and 0 <= pos <= max_pos:
                words[pos] = token
    return " ".join(word for word in words if word).strip()


def europepmc_source_meta(source_code: str) -> Dict[str, str]:
    code = str(source_code or "").strip().upper()
    mapping = {
        "MED": {"source_kind": "pubmed", "source_label": "PubMed"},
        "PMC": {"source_kind": "pmc", "source_label": "PMC"},
        "PPR": {"source_kind": "preprint", "source_label": "Preprint"},
    }
    return mapping.get(code, {"source_kind": "europepmc", "source_label": "Europe PMC"})


def normalize_arxiv_result(item: Dict[str, Any]) -> Dict[str, Any]:
    arxiv_id = str(item.get("arxiv_id") or "").strip()
    title = str(item.get("title") or arxiv_id or "Untitled").strip()
    src_url = str(item.get("src_url") or "").strip() or (f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else "")
    pdf_url = src_url or (f"https://arxiv.org/pdf/{arxiv_id}.pdf" if arxiv_id else "")
    return {
        **item,
        "paper_key": build_paper_key("arxiv", arxiv_id, title),
        "source_kind": "arxiv",
        "source_label": "arXiv",
        "arxiv_id": arxiv_id,
        "openalex_id": "",
        "europepmc_id": "",
        "europepmc_source": "",
        "doi": normalize_doi(item.get("doi")),
        "pdf_url": pdf_url,
        "external_url": src_url,
        "src_url": src_url,
        "publish_at": item.get("publish_at") or item.get("published_at") or "",
        "citation": item.get("citation") or item.get("citations") or 0,
        "supports_favorite": bool(arxiv_id),
    }


def normalize_openalex_result(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    openalex_id = extract_openalex_id(item.get("id") or item.get("ids", {}).get("openalex") or "")
    title = str(item.get("display_name") or item.get("title") or openalex_id or "Untitled").strip()
    if not openalex_id and not title:
        return None
    authors = [
        str(((authorship or {}).get("author") or {}).get("display_name") or "").strip()
        for authorship in (item.get("authorships") or [])
        if isinstance(authorship, dict)
    ]
    primary_location = item.get("primary_location") or {}
    open_access = item.get("open_access") or {}
    pdf_url = str(primary_location.get("pdf_url") or "").strip() or str(open_access.get("oa_url") or "").strip()
    src_url = (
        str(primary_location.get("landing_page_url") or "").strip()
        or pdf_url
        or str(item.get("doi") or "").strip()
        or str(item.get("id") or "").strip()
    )
    publish_at = str(item.get("publication_date") or "").strip()
    if not publish_at and item.get("publication_year"):
        publish_at = f"{item['publication_year']}-01-01"
    doi = normalize_doi(item.get("doi") or item.get("ids", {}).get("doi"))
    abstract_text = reconstruct_openalex_abstract(item.get("abstract_inverted_index"))
    return {
        **item,
        "paper_key": build_paper_key("openalex", openalex_id or doi, title),
        "source_kind": "openalex",
        "source_label": "OpenAlex",
        "title": title,
        "abstract": abstract_text,
        "author_line": to_author_line_from_names(authors),
        "publish_at": publish_at,
        "arxiv_id": extract_arxiv_id(src_url),
        "openalex_id": openalex_id,
        "europepmc_id": "",
        "europepmc_source": "",
        "doi": doi,
        "pdf_url": pdf_url,
        "external_url": src_url,
        "src_url": src_url,
        "citation": item.get("cited_by_count") or 0,
        "supports_favorite": False,
    }


def normalize_europepmc_result(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source_code = str(item.get("source") or "").strip().upper()
    europepmc_id = str(item.get("id") or item.get("pmid") or item.get("pmcid") or "").strip()
    title = str(item.get("title") or europepmc_id or "Untitled").strip()
    if not europepmc_id and not title:
        return None
    meta = europepmc_source_meta(source_code)
    abstract_text = str(item.get("abstractText") or item.get("abstract") or "").strip()
    full_text_ids = ((item.get("fullTextIdList") or {}).get("fullTextId") or []) if isinstance(item.get("fullTextIdList"), dict) else []
    pmcid = str(item.get("pmcid") or next((value for value in full_text_ids if str(value).upper().startswith("PMC")), "") or "").strip().upper()
    pdf_url = f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/" if pmcid else ""
    landing_url = f"https://europepmc.org/article/{source_code}/{europepmc_id}" if source_code and europepmc_id else ""
    doi = normalize_doi(item.get("doi"))
    return {
        **item,
        "paper_key": build_paper_key(meta["source_kind"], europepmc_id or doi, title),
        "source_kind": meta["source_kind"],
        "source_label": meta["source_label"],
        "title": title,
        "abstract": abstract_text,
        "author_line": str(item.get("authorString") or "").strip(),
        "publish_at": str(item.get("firstPublicationDate") or item.get("firstIndexDate") or item.get("pubYear") or "").strip(),
        "arxiv_id": "",
        "openalex_id": "",
        "europepmc_id": europepmc_id,
        "europepmc_source": source_code,
        "pmcid": pmcid,
        "doi": doi,
        "pdf_url": pdf_url,
        "external_url": landing_url,
        "src_url": landing_url,
        "citation": item.get("citedByCount") or 0,
        "supports_favorite": False,
    }


def merge_results(items: List[Dict[str, Any]], limit: int, max_per_group: Optional[int] = None) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = paper_identity_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(item)
    merged.sort(
        key=lambda item: (
            -parse_publish_time(item.get("publish_at")),
            SOURCE_PRIORITY.get(str(item.get("source_kind") or "europepmc"), 99),
            str(item.get("title") or "").lower(),
        )
    )
    if max_per_group:
        grouped_counts: Dict[str, int] = {}
        diversified: List[Dict[str, Any]] = []
        for item in merged:
            group = source_group(item)
            count = grouped_counts.get(group, 0)
            if count >= max_per_group:
                continue
            grouped_counts[group] = count + 1
            diversified.append(item)
            if len(diversified) >= limit:
                return diversified
        return diversified[:limit]
    return merged[:limit]


def search_arxiv(query: str, limit: int, mode: str) -> Dict[str, Any]:
    result = make_reader().search(query, size=limit, search_mode=mode) or {"results": [], "total": 0}
    items = [normalize_arxiv_result(item) for item in result.get("results", []) if isinstance(item, dict)]
    return {"total": result.get("total", len(items)), "results": items}


def search_openalex(query: str, limit: int) -> List[Dict[str, Any]]:
    response = http_get_json(
        OPENALEX_WORKS_URL,
        {
            "search": query,
            "per-page": min(max(limit, 1), 25),
            "filter": f"to_publication_date:{date.today().isoformat()}",
        },
    )
    return [
        item
        for item in (normalize_openalex_result(entry) for entry in (response.get("results") or []))
        if item
    ]


def search_europepmc(query: str, limit: int) -> List[Dict[str, Any]]:
    response = http_get_json(
        EUROPEPMC_SEARCH_URL,
        {
            "query": query,
            "format": "json",
            "pageSize": min(max(limit, 1), 25),
            "resultType": "lite",
        },
    )
    result_list = ((response.get("resultList") or {}).get("result") or [])
    return [
        item
        for item in (normalize_europepmc_result(entry) for entry in result_list if isinstance(entry, dict))
        if item
    ]


def normalize_sections(sections: Any) -> List[Dict[str, Any]]:
    if isinstance(sections, list):
        result = []
        for index, item in enumerate(sections):
            if isinstance(item, dict):
                result.append(
                    {
                        "name": item.get("name") or f"Section {index + 1}",
                        "idx": item.get("idx", index),
                        "tldr": item.get("tldr", ""),
                        "token_count": item.get("token_count", 0),
                    }
                )
            else:
                result.append({"name": str(item), "idx": index, "tldr": "", "token_count": 0})
        return sorted(result, key=lambda item: item.get("idx", 0))
    if isinstance(sections, dict):
        result = []
        for index, (name, value) in enumerate(sections.items()):
            value = value or {}
            result.append(
                {
                    "name": name,
                    "idx": value.get("idx", index),
                    "tldr": value.get("tldr", ""),
                    "token_count": value.get("token_count", 0),
                }
            )
        return sorted(result, key=lambda item: item.get("idx", 0))
    return []


def cmd_search(payload: Dict[str, Any]) -> Dict[str, Any]:
    query = str(payload.get("query") or "").strip()
    if not query:
        raise ValueError("请输入搜索关键词")
    limit = max(1, min(int(payload.get("limit", 10)), 50))
    mode = str(payload.get("mode") or "hybrid").strip() or "hybrid"
    source_scope = str(payload.get("source_scope") or "mixed").strip().lower()

    if source_scope == "arxiv":
        return search_arxiv(query, limit, mode)
    if source_scope == "openalex":
        items = search_openalex(query, limit)
        return {"total": len(items), "results": merge_results(items, limit)}
    if source_scope == "europepmc":
        items = search_europepmc(query, limit)
        return {"total": len(items), "results": merge_results(items, limit)}
    if source_scope != "mixed":
        raise ValueError("不支持的搜索源")

    per_source_limit = min(max(limit * 2, 12), 24)
    results: List[Dict[str, Any]] = []

    try:
        results.extend(search_arxiv(query, per_source_limit, mode).get("results", []))
    except Exception:
        pass

    try:
        results.extend(search_openalex(query, per_source_limit))
    except Exception:
        pass

    try:
        results.extend(search_europepmc(query, per_source_limit))
    except Exception:
        pass

    merged = merge_results(results, limit, max_per_group=max(2, (limit + 1) // 2))
    return {"total": len(merged), "results": merged}


def cmd_trending(payload: Dict[str, Any]) -> Dict[str, Any]:
    return make_reader().trending(days=int(payload.get("days", 7)), limit=int(payload.get("limit", 20))) or {"papers": [], "total": 0}


def cmd_snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    source_kind = str(payload.get("source_kind") or "").strip().lower()
    arxiv_id = str(payload.get("arxiv_id") or "").strip()
    openalex_id = extract_openalex_id(payload.get("openalex_id") or "")
    europepmc_id = str(payload.get("europepmc_id") or "").strip()
    europepmc_source = str(payload.get("europepmc_source") or "").strip().upper()
    local_pdf_path = str(payload.get("local_pdf_path") or "").strip()

    if local_pdf_path or source_kind == "local-pdf":
        if not local_pdf_path:
            raise ValueError("缺少本地 PDF 路径")
        normalized = parse_local_pdf(local_pdf_path)
        brief = {
            "title": normalized.get("title", "Untitled"),
            "tldr": normalized.get("abstract", ""),
            "publish_at": normalized.get("publish_at", ""),
            "src_url": normalized.get("src_url", ""),
            "pdf_url": normalized.get("local_pdf_path", ""),
            "citations": 0,
        }
        return {
            "local_pdf_path": normalized.get("local_pdf_path", local_pdf_path),
            "source_kind": "local-pdf",
            "source_label": "本地 PDF",
            "brief": brief,
            "head": {
                **normalized,
                "abstract": normalized.get("abstract", ""),
                "src_url": normalized.get("src_url", ""),
                "pdf_url": normalized.get("local_pdf_path", ""),
            },
            "sections": normalized.get("sections", []),
        }

    if openalex_id or source_kind == "openalex":
        if not openalex_id:
            raise ValueError("缺少 OpenAlex 论文 ID")
        work = http_get_json(f"{OPENALEX_WORKS_URL}/{openalex_id}")
        normalized = normalize_openalex_result(work)
        if not normalized:
            raise RuntimeError("未获取到 OpenAlex 论文详情")
        brief = {
            "title": normalized.get("title", openalex_id),
            "tldr": normalized.get("abstract", ""),
            "publish_at": normalized.get("publish_at", ""),
            "src_url": normalized.get("src_url", ""),
            "pdf_url": normalized.get("pdf_url", ""),
            "citations": normalized.get("citation", 0),
        }
        return {
            "openalex_id": openalex_id,
            "source_kind": "openalex",
            "source_label": "OpenAlex",
            "brief": brief,
            "head": {**normalized, "abstract": normalized.get("abstract", "")},
            "sections": [],
        }

    if europepmc_id or source_kind in {"pubmed", "pmc", "preprint", "europepmc"}:
        source_map = {
            "pubmed": "MED",
            "pmc": "PMC",
            "preprint": "PPR",
            "europepmc": "MED",
        }
        source_code = europepmc_source or source_map.get(source_kind, "")
        if not europepmc_id or not source_code:
            raise ValueError("缺少 Europe PMC 论文参数")
        response = http_get_json(
            EUROPEPMC_ARTICLE_URL.format(source=source_code, id=europepmc_id),
            {"format": "json", "resultType": "core"},
        )
        result = response.get("result") if isinstance(response.get("result"), dict) else response
        normalized = normalize_europepmc_result(result)
        if not normalized:
            raise RuntimeError("未获取到 Europe PMC 论文详情")
        brief = {
            "title": normalized.get("title", europepmc_id),
            "tldr": normalized.get("abstract", ""),
            "publish_at": normalized.get("publish_at", ""),
            "src_url": normalized.get("src_url", ""),
            "pdf_url": normalized.get("pdf_url", ""),
            "citations": normalized.get("citation", 0),
        }
        return {
            "europepmc_id": normalized.get("europepmc_id", europepmc_id),
            "europepmc_source": normalized.get("europepmc_source", source_code),
            "source_kind": normalized.get("source_kind", "europepmc"),
            "source_label": normalized.get("source_label", "Europe PMC"),
            "brief": brief,
            "head": {**normalized, "abstract": normalized.get("abstract", "")},
            "sections": [],
        }

    if not arxiv_id:
        raise ValueError("缺少论文 ID")
    reader = make_reader()
    brief = reader.brief(arxiv_id) or {}
    head = reader.head(arxiv_id) or {}
    return {
        "arxiv_id": arxiv_id,
        "source_kind": "arxiv",
        "source_label": "arXiv",
        "brief": brief,
        "head": head,
        "sections": normalize_sections(head.get("sections")),
    }


def cmd_section(payload: Dict[str, Any]) -> Dict[str, Any]:
    arxiv_id = str(payload.get("arxiv_id") or "").strip()
    section_name = str(payload.get("section_name") or "").strip()
    if not arxiv_id or not section_name:
        raise ValueError("缺少章节参数")
    return {"content": make_reader().section(arxiv_id, section_name)}


COMMANDS = {
    "token-status": lambda payload: token_summary(),
    "register-token": lambda payload: register_token(),
    "save-token": lambda payload: save_manual_token(str(payload.get("token") or "")),
    "search": cmd_search,
    "trending": cmd_trending,
    "snapshot": cmd_snapshot,
    "import-local-pdf": lambda payload: parse_local_pdf(str(payload.get("path") or "")),
    "section": cmd_section,
}


def emit_ok(data: Any) -> None:
    emit_json({"ok": True, "data": data})


def emit_error(message: str) -> None:
    emit_json({"ok": False, "error": str(message)})


def emit_json(payload: Dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
    data = text.encode("ascii", errors="backslashreplace")
    stdout_buffer = getattr(sys.stdout, "buffer", None)
    if stdout_buffer:
        stdout_buffer.write(data)
        stdout_buffer.flush()
        return
    sys.stdout.write(data.decode("ascii", errors="replace"))
    sys.stdout.flush()


def main() -> int:
    try:
        command = sys.argv[1]
    except IndexError:
        emit_error("缺少命令")
        return 1

    raw_payload = sys.argv[2] if len(sys.argv) > 2 else "{}"
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        emit_error("请求参数格式错误")
        return 1

    handler = COMMANDS.get(command)
    if not handler:
        emit_error("未知命令")
        return 1

    try:
        emit_ok(handler(payload))
        return 0
    except Exception as exc:
        emit_error(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
