import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import signSiriExtension from "./sign-siri-extension.mjs";

/** Directory packages need the same release feed as installer packages. */
export async function ensureUpdateConfig(context) {
  const { packager, appOutDir } = context;
  // Match the builder's platform-level override precedence, including an
  // explicit null (which must not silently fall back to a release feed).
  const publish = packager.platformSpecificBuildOptions.publish !== undefined
    ? packager.platformSpecificBuildOptions.publish
    : packager.config.publish;
  if (
    !publish || Array.isArray(publish) || publish.provider !== "github" ||
    ![publish.owner, publish.repo, packager.appInfo.updaterCacheDirName].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    throw new Error("Desktop packaging requires a GitHub publish provider, owner, repository and updater cache directory.");
  }
  const expected = {
    provider: publish.provider,
    owner: publish.owner,
    repo: publish.repo,
    updaterCacheDirName: packager.appInfo.updaterCacheDirName,
  };
  const path = join(packager.getResourcesDir(appOutDir), "app-update.yml");
  try {
    // Do not replace builder-generated fields (for example publisherName on
    // signed Windows installers), or put publishing credentials in the app.
    await writeFile(path, dump(expected), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const actual = load(await readFile(path, "utf8"));
  for (const [key, value] of Object.entries(expected)) {
    if (!actual || actual[key] !== value) {
      throw new Error(`Invalid packaged app-update.yml: ${key} does not match the release configuration.`);
    }
  }
}

export default async function afterPack(context) {
  await ensureUpdateConfig(context);
  await signSiriExtension(context);
}
