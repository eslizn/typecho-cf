const semver = require('semver');

module.exports = {
  filterResults(packageName, { upgradedVersionSemver }) {
    if (packageName !== 'typescript') return true;

    // typescript-eslint currently supports TypeScript <6.1.0. Keep tracking
    // compatible releases while filtering unsupported TypeScript 7 upgrades.
    return semver.satisfies(upgradedVersionSemver.version, '>=4.8.4 <6.1.0');
  },
};
