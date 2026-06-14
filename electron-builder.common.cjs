const common = {
  directories: {
    output: 'release',
  },
  files: [
    'dist/**/*',
    'electron/**/*',
    'server/**/*',
    'package.json',
  ],
  extraMetadata: {
    main: 'electron/main.cjs',
  },
};

module.exports = common;
