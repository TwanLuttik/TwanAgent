import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const env = { ...process.env };

if (process.platform === "win32") {
  configureWindowsBuild(env);
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function configureWindowsBuild(environment) {
  const visualStudioInstallations = findVisualStudioInstallations();
  const visualStudio2022 = visualStudioInstallations.find((path) =>
    path.replaceAll("\\", "/").includes("/2022/"),
  );
  const msvcInclude = findMsvcInclude(visualStudio2022 ?? visualStudioInstallations[0]);
  const windowsSdkIncludes = findWindowsSdkIncludes();

  if (msvcInclude) {
    environment.INCLUDE = [msvcInclude, ...windowsSdkIncludes, environment.INCLUDE]
      .filter(Boolean)
      .join(delimiter);
  }

  if (!environment.CMAKE_GENERATOR && visualStudio2022) {
    environment.CMAKE_GENERATOR = "Visual Studio 17 2022";
  }

  if (!environment.LIBCLANG_PATH || !environment.BINDGEN_EXTRA_CLANG_ARGS) {
    configureBindgen(environment, msvcInclude);
  }
}

function configureBindgen(environment, msvcInclude) {
  const llvmBin = join(process.env.ProgramFiles ?? "C:/Program Files", "LLVM", "bin");
  const clang = join(llvmBin, "clang.exe");
  const libclang = join(llvmBin, "libclang.dll");

  if (!existsSync(clang) || !existsSync(libclang)) {
    throw new Error(
      "Windows builds need LLVM with libclang. Install LLVM to C:\\Program Files\\LLVM or set LIBCLANG_PATH and BINDGEN_EXTRA_CLANG_ARGS.",
    );
  }
  if (!msvcInclude && !environment.BINDGEN_EXTRA_CLANG_ARGS) {
    throw new Error(
      "Could not locate the Visual C++ include directory. Install the Visual Studio C++ build tools or set BINDGEN_EXTRA_CLANG_ARGS.",
    );
  }

  environment.LIBCLANG_PATH ??= llvmBin;
  if (!environment.BINDGEN_EXTRA_CLANG_ARGS) {
    const resourceDir = execFileSync(clang, ["--print-resource-dir"], { encoding: "utf8" }).trim();
    environment.BINDGEN_EXTRA_CLANG_ARGS = [
      "--target=x86_64-pc-windows-msvc",
      `-resource-dir "${resourceDir}"`,
      `-isystem "${msvcInclude}"`,
      ...findWindowsSdkIncludes().map((include) => `-isystem "${include}"`),
    ].join(" ");
  }
}

function findVisualStudioInstallations() {
  const roots = [
    join(process.env.ProgramFiles ?? "C:/Program Files", "Microsoft Visual Studio"),
    join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio"),
  ];
  const installations = [];

  for (const root of roots) {
    for (const version of readDirectories(root)) {
      for (const edition of readDirectories(join(root, version))) {
        const installation = join(root, version, edition);
        if (existsSync(join(installation, "VC", "Tools", "MSVC"))) {
          installations.push(installation);
        }
      }
    }
  }

  return installations;
}

function findMsvcInclude(installation) {
  if (!installation) {
    return undefined;
  }

  const msvcRoot = join(installation, "VC", "Tools", "MSVC");
  const version = readDirectories(msvcRoot).sort((left, right) => right.localeCompare(left))[0];
  const include = version && join(msvcRoot, version, "include");
  return include && existsSync(include) ? include : undefined;
}

function findWindowsSdkIncludes() {
  const sdkRoot = join(
    process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
    "Windows Kits",
    "10",
    "Include",
  );
  const sdkVersion = readDirectories(sdkRoot).sort((left, right) => right.localeCompare(left))[0];
  if (!sdkVersion) {
    return [];
  }

  return ["ucrt", "shared", "um"]
    .map((directory) => join(sdkRoot, sdkVersion, directory))
    .filter((path) => existsSync(path));
}

function readDirectories(path) {
  try {
    return readdirSync(path).filter((name) => {
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
