/*
  MIT License

  Copyright (c) 2019 Fred K. Schott

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

const inject = require("@rollup/plugin-inject");
const generateProcessPolyfill = require("./generatePolyfill");

const PROCESS_MODULE_NAME = "process";
function rollupPluginNodeProcessPolyfill(vars = {}) {
  const injectPlugin = inject({
    process: PROCESS_MODULE_NAME,
  });

  return {
    ...injectPlugin,
    name: "snowpack:rollup-plugin-node-process-polyfill",
    resolveId(source) {
      if (source === PROCESS_MODULE_NAME) {
        return PROCESS_MODULE_NAME;
      }

      return null;
    },
    load(id) {
      if (id === PROCESS_MODULE_NAME) {
        return createProcessPolyfill(vars);
      }

      return null;
    },
  };
}

function createProcessPolyfill(vars = {}) {
  const env = Object.keys(vars).reduce((acc, id) => {
    return {
      ...acc,
      [id]: vars[id] === true ? process.env[id] : vars[id],
    };
  }, {});

  return { code: generateProcessPolyfill(env), moduleSideEffects: false };
}

module.exports = rollupPluginNodeProcessPolyfill;
