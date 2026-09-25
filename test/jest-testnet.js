module.exports = {
  ...require("../jest.config"),
  rootDir: "..",
  roots: ["<rootDir>/test/testnet"],
  testRegex: ".*\\.testnet\\.ts$",
  moduleNameMapper: { "^src/(.*)$": "<rootDir>/src/$1" },
  testTimeout: 120000,
};
