import { readFile } from "node:fs/promises";
import path from "node:path";
const URL = "https://aigengames.pages.dev/Games/SurviveLimitMononoke/";

// 通常は公開URLをそのまま使います。このWork環境の証明書制約では、
// 別途取得した「無変更の公開ファイル」を同じURLへ応答する検証にも対応します。
// 配布物にゲームのコード・モデル・画像を同梱しません。
export async function fixtureRoute(page) {
  const directory = process.env.MONONOKE_FIXTURE;
  if (!directory) return;
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(URL)) {
      const relative =
        decodeURIComponent(url.slice(URL.length).split("?")[0]) || "index.html";
      const file = path.resolve(directory, relative);
      if (!file.startsWith(path.resolve(directory) + path.sep))
        return route.abort();
      const contentType = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html";
      return route.fulfill({
        status: 200,
        contentType,
        body: await readFile(file),
      });
    }
    if (
      url.includes("cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js")
    ) {
      return route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: await readFile(path.join(directory, "three.min.js")),
      });
    }
    // 外部フォントはゲームロジックに関係しません。検証時は空のCSSとします。
    if (url.startsWith("https://fonts.googleapis.com/"))
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.abort();
  });
}
