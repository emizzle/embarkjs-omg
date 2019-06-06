/* global module require */

const cloneDeep = require('lodash.clonedeep');

module.exports = (api) => {
  const env = api.env();

  const base = {};

  const browser = cloneDeep(base);

  const node = cloneDeep(base);

  // const nodeTest = cloneDeep(base);

  switch (env) {
    case 'browser':
      return browser;
    case 'node':
      return node;
    // case 'node:test':
    //   return nodeTest;
    default:
      return base;
  }
};
