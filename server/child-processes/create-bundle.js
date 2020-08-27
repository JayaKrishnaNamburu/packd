// const fs = require('fs');
const path = require("path");
const sander = require("sander");
const child_process = require("child_process");
const tar = require("tar");
const request = require("request");
// const browserify = require('browserify');
const rollup = require("rollup");
const { nodeResolve } = require("@rollup/plugin-node-resolve");
const commonjs = require("@rollup/plugin-commonjs");
const replace = require("rollup-plugin-replace");
// const rollupPluginNodeProcessPolyfill = require("../plugins/rollup-snowpack-process-polyfill");
// const Terser = require("terser");
const importMap = require("rollup-plugin-esm-import-to-url");
const isModule = require("is-module");
const makeLegalIdentifier = require("../utils/makeLegalIdentifier");

const { npmInstallEnvVars, root, tmpdir } = require("../../config.js");

process.on("message", (message) => {
  if (message.type === "start") {
    createBundle(message.params);
  }
});

process.send("ready");

async function createBundle({ hash, pkg, version, deep, query }) {
  const dir = `${tmpdir}/${hash}`;
  const cwd = `${dir}/package`;

  try {
    await sander.mkdir(dir);
    await fetchAndExtract(pkg, version, dir);
    await sanitizePkg(cwd);
    await installDependencies(cwd);

    const code = await bundle(cwd, deep, query);

    info(`[${pkg.name}] minifying`);

    // const result = Terser.minify(code);

    // if (result.error) {
    //   info(`[${pkg.name}] minification failed: ${result.error.message}`);
    // }

    process.send({
      type: "result",
      code,
      //   code: result.error ? code : result.code,
    });
  } catch (err) {
    process.send({
      type: "error",
      message: err.message,
      stack: err.stack,
    });
  }

  sander.rimraf(dir);
}

function fetchAndExtract(pkg, version, dir) {
  const tarUrl = pkg.versions[version].dist.tarball;

  info(`[${pkg.name}] fetching ${tarUrl}`);

  return new Promise((fulfil, reject) => {
    let timedout = false;

    const timeout = setTimeout(() => {
      reject(new Error("Request timed out"));
      timedout = true;
    }, 10000);

    const input = request(tarUrl);

    // don't like going via the filesystem, but piping into targz
    // was failing for some weird reason
    const intermediate = sander.createWriteStream(`${dir}/package.tgz`);

    input.pipe(intermediate);

    intermediate.on("close", () => {
      clearTimeout(timeout);

      if (!timedout) {
        info(`[${pkg.name}] extracting to ${dir}/package`);

        tar
          .x({
            file: `${dir}/package.tgz`,
            cwd: dir,
          })
          .then(fulfil, reject);
      }
    });
  });
}

function sanitizePkg(cwd) {
  const pkg = require(`${cwd}/package.json`);
  pkg.peerDependencies = Object.keys(pkg.peerDependencies).reduce(
    (acc, item) => {
      info(item);
      if (!item.includes("react")) {
        return (acc = {
          ...acc,
          [item]: pkg.peerDependencies[item],
        });
      }
      return acc;
    },
    {}
  );
  info(JSON.stringify(pkg.peerDependencies, null, 2));
  pkg.scripts = {};
  return sander.writeFile(
    `${cwd}/package.json`,
    JSON.stringify(pkg, null, "  ")
  );
}

function installDependencies(cwd) {
  const pkg = require(`${cwd}/package.json`);

  const envVariables = npmInstallEnvVars.join(" ");
  const installCommand = `${envVariables} ${root}/node_modules/.bin/npm install --production`;

  info(`[${pkg.name}] running ${installCommand}`);

  return exec(installCommand, cwd, pkg).then(() => {
    if (!pkg.peerDependencies) return;

    return Object.keys(pkg.peerDependencies).reduce((promise, name) => {
      return promise.then(() => {
        info(`[${pkg.name}] installing peer dependency ${name}`);
        const version = pkg.peerDependencies[name];
        return exec(
          `${root}/node_modules/.bin/npm install "${name}@${version}"`,
          cwd,
          pkg
        );
      });
    }, Promise.resolve());
  });
}

function bundle(cwd, deep, query) {
  const pkg = require(`${cwd}/package.json`);
  const moduleName = query.name || makeLegalIdentifier(pkg.name);

  const entryName = pkg.module || pkg["jsnext:main"] || pkg.main;

  if (!entryName) {
    throw new Error(
      "package has no entry file; please specify a `module` key in your `package.json`."
    );
  }

  const entry = deep
    ? path.resolve(cwd, deep)
    : findEntry(path.resolve(cwd, entryName));

  const code = sander.readFileSync(entry, { encoding: "utf-8" });

  if (isModule(code)) {
    info(`[${pkg.name}] ES2015 module found, using Rollup`);
    return bundleWithRollup(cwd, pkg, entry, moduleName);
  } else {
    info(`[${pkg.name}] No ES2015 module found, using Browserify`);
    info(`Anyway bundling ${pkg.name} using rollup`);
    return bundleWithRollup(cwd, pkg, entry, moduleName);
    // return bundleWithBrowserify(pkg, entry, moduleName, format);
  }
}

function findEntry(file) {
  try {
    const stats = sander.statSync(file);
    if (stats.isDirectory()) return `${file}/index.js`;
    return file;
  } catch (err) {
    return `${file}.js`;
  }
}

async function bundleWithRollup(cwd, pkg, moduleEntry, name) {
  const bundle = await rollup.rollup({
    input: path.resolve(cwd, moduleEntry),
    plugins: [
      replace({
        "process.env.NODE_ENV": JSON.stringify("production"),
      }),
      nodeResolve({
        mainFields: ["browser", "jsnext:main", "module", "main"],
      }),
      commonjs(),
      importMap({
        imports: {
          react: "https://cdn.skypack.dev/react@latest",
          "react-dom": "https://cdn.skypack.dev/react-dom@latest",
        },
      }),
    ],
  });

  const result = await bundle.generate({
    format: "esm",
    name,
  });

  if (result.output.length > 1) {
    info(
      `Failed to generate esm bundle, created multipled bundles instead  - created ${result.output.length}`
    );
    throw new Error(`Failed to generate esm bundle for ${pkg.name}`);
  }

  // if (result.output.length > 1) {
  // 	info(`[${pkg.name}] generated multiple chunks, trying Browserify instead`);
  // 	return bundleWithBrowserify(pkg, moduleEntry, name, format);
  // }

  // if (result.output[0].imports.length > 0) {
  // 	info(`Handling for the dependency ${name}, ${moduleEntry}`);
  // 	info(
  // 		`[${pkg.name}] non-ES2015 dependencies found, handing off to Browserify`
  // 	);

  // 	const intermediate = `${cwd}/__intermediate.js`;
  // 	const { code } = await bundle.generate({
  // 		format: 'cjs'
  // 	});

  // 	fs.writeFileSync(intermediate, code);
  // 	return bundleWithBrowserify(pkg, intermediate, name, format);
  // }

  info(`[${pkg.name}] bundled using Rollup`);

  return result.output[0].code;
}

// function bundleWithBrowserify(pkg, main, moduleName, format) {
// 	if (format === 'esm') {
// 		throw new Error(`Failed to generate ES module`);
// 	}

// 	const b = browserify(main, {
// 		standalone: moduleName
// 	});

// 	return new Promise((fulfil, reject) => {
// 		b.bundle((err, buf) => {
// 			if (err) {
// 				reject(err);
// 			} else {
// 				info(`[${pkg.name}] bundled using Browserify`);
// 				fulfil('' + buf);
// 			}
// 		});
// 	});
// }

function exec(cmd, cwd, pkg) {
  return new Promise((fulfil, reject) => {
    child_process.exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }

      stdout.split("\n").forEach((line) => {
        info(`[${pkg.name}] ${line}`);
      });

      stderr.split("\n").forEach((line) => {
        info(`[${pkg.name}] ${line}`);
      });

      fulfil();
    });
  });
}

function info(message) {
  process.send({
    type: "info",
    message,
  });
}
