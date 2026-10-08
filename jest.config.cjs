module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      { tsconfig: { allowJs: true, module: 'CommonJS' } },
    ],
  },
  // sanitize-html's maintained parser dependencies are ESM; test their real code.
  transformIgnorePatterns: [
    'node_modules/(?!(htmlparser2|domhandler|domutils|domelementtype|entities|dom-serializer)/)',
  ],
};
