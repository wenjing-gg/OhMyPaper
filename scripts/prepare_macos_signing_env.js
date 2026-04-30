const fs = require('fs');
const path = require('path');

function hasValue(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function appendGithubEnv(name, value) {
  const envPath = process.env.GITHUB_ENV;
  if (!envPath) return;
  fs.appendFileSync(envPath, `${name}=${value}\n`, 'utf-8');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function warn(message) {
  console.warn(message);
}

function prepareAppleApiKeyFile() {
  if (!hasValue('APPLE_API_KEY_B64')) {
    return;
  }
  if (!hasValue('APPLE_API_KEY_ID') || !hasValue('APPLE_API_ISSUER')) {
    fail('APPLE_API_KEY_B64 is set, but APPLE_API_KEY_ID or APPLE_API_ISSUER is missing.');
  }
  const outputDir = process.env.RUNNER_TEMP || process.cwd();
  const outputPath = path.join(outputDir, `AuthKey_${process.env.APPLE_API_KEY_ID}.p8`);
  const decoded = Buffer.from(process.env.APPLE_API_KEY_B64, 'base64').toString('utf-8');
  if (!decoded.includes('BEGIN PRIVATE KEY')) {
    fail('APPLE_API_KEY_B64 does not decode to an App Store Connect .p8 private key.');
  }
  fs.writeFileSync(outputPath, decoded, { mode: 0o600 });
  appendGithubEnv('APPLE_API_KEY', outputPath);
  process.env.APPLE_API_KEY = outputPath;
}

function hasNotarizationAuth() {
  const hasApiKeyAuth = hasValue('APPLE_API_KEY') && hasValue('APPLE_API_KEY_ID') && hasValue('APPLE_API_ISSUER');
  const hasAppleIdAuth = hasValue('APPLE_ID') && hasValue('APPLE_APP_SPECIFIC_PASSWORD') && hasValue('APPLE_TEAM_ID');
  const hasKeychainAuth = hasValue('APPLE_KEYCHAIN_PROFILE');
  return hasApiKeyAuth || hasAppleIdAuth || hasKeychainAuth;
}

function hasAnyNotarizationSecret() {
  return [
    'APPLE_API_KEY',
    'APPLE_API_KEY_B64',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_KEYCHAIN_PROFILE',
  ].some(hasValue);
}

function disableCodeSigningAutoDiscovery() {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  appendGithubEnv('CSC_IDENTITY_AUTO_DISCOVERY', 'false');
  appendGithubEnv('MAC_SIGNING_MODE', 'unsigned');
}

function main() {
  if (process.platform !== 'darwin') {
    return;
  }

  prepareAppleApiKeyFile();

  if (!process.env.CI) {
    console.log('Local macOS build: signing credentials are optional. Release builds must provide them in CI.');
    return;
  }

  const hasSigningCert = hasValue('CSC_LINK') && hasValue('CSC_KEY_PASSWORD');
  const hasPartialSigningCert = hasValue('CSC_LINK') || hasValue('CSC_KEY_PASSWORD');
  if (hasPartialSigningCert && !hasSigningCert) {
    fail('Partial macOS signing certificate configuration: both CSC_LINK and CSC_KEY_PASSWORD are required.');
  }

  if (!hasSigningCert) {
    disableCodeSigningAutoDiscovery();
    warn('Missing macOS signing certificate secrets. Falling back to unsigned/ad-hoc macOS packaging.');
    return;
  }

  appendGithubEnv('MAC_SIGNING_MODE', 'signed');

  if (!hasNotarizationAuth()) {
    if (hasAnyNotarizationSecret()) {
      fail('Partial Apple notarization configuration. Provide APPLE_API_KEY_B64 + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.');
    }
    warn('Missing Apple notarization credentials. The app will be packaged without notarization.');
  }

  console.log('macOS signing and notarization environment is ready.');
}

main();
