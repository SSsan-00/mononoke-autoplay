import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureRoute } from "./fixture.js";
import { configureGame, playSession } from "../src/cli.js";
import { loadPredictionEngine } from "../src/engine.js";
import { PlannerPolicy } from "../src/planner.js";

test(
  "各敵5体を経路探索と先読みでクリアする",
  {
    skip: process.env.RUN_HARD_BROWSER_TESTS !== "1",
    timeout: 1800000,
  },
  async () => {
    const engine = await loadPredictionEngine();
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
        : {}),
      args:
        process.env.TEST_SWIFTSHADER === "1"
          ? [
              "--no-sandbox",
              "--use-gl=angle",
              "--use-angle=swiftshader",
              "--enable-unsafe-swiftshader",
            ]
          : [],
    });
    const directory = path.resolve(
      process.env.HARD_OUTPUT || "verification/v1.2-browser",
    );
    await mkdir(directory, { recursive: true });
    const records = [];
    try {
      const profiles = process.env.HARD_PROFILES
        ? JSON.parse(process.env.HARD_PROFILES)
        : [
            ["L", "1"],
            ["S", "1"],
          ];
      const time = process.env.HARD_TIME || "30";
      for (const [field, lives] of profiles) {
        const page = await browser.newPage({
          viewport: { width: 400, height: 700 },
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await fixtureRoute(page);
        await page.goto(
          "https://aigengames.pages.dev/Games/SurviveLimitMononoke/",
          { waitUntil: "networkidle" },
        );
        await configureGame(page, {
          field,
          lives,
          time,
          "each-enemy": "5",
        });
        let cleared = false;
        for (let attempt = 1; attempt <= 6; attempt++) {
          if (attempt > 1)
            await page
              .getByRole("button", { name: "結界条件を再調整", exact: true })
              .click();
          let reported = -5000;
          let previousStatus = null;
          const summary = await playSession(page, new PlannerPolicy(engine), {
            onState: (s) => {
              if (
                s.elapsedMs - reported >= 5000 ||
                s.status !== previousStatus
              ) {
                console.log(
                  `hard ${field}/life${lives} #${attempt}: ${(s.elapsedMs / 1000).toFixed(1)}s ${s.status} lives=${s.lives}`,
                );
                reported = s.elapsedMs;
                previousStatus = s.status;
              }
            },
          });
          assert.equal(summary.challenge.field, field);
          assert.equal(summary.challenge.lives, Number(lives));
          assert.equal(summary.challenge.time, Number(time));
          assert.deepEqual(
            Object.values(summary.challenge.enemies),
            [5, 5, 5, 5, 5, 5],
          );
          await page
            .getByRole("button", { name: "同条件で再出陣", exact: true })
            .waitFor({ timeout: 15000 });
          const record = {
            pageErrors: [...errors],
            field,
            initialLives: Number(lives),
            attempt,
            ...summary,
          };
          records.push(record);
          await writeFile(
            path.join(directory, "hard-browser-results.json"),
            JSON.stringify(records, null, 2),
          );
          await page.screenshot({
            path: path.join(directory, `hard-${field}-attempt-${attempt}.png`),
            fullPage: true,
          });
          console.log(JSON.stringify(record));
          if (summary.status === "cleared") {
            cleared = true;
            break;
          }
        }
        assert.equal(cleared, true, `${field}条件を6回以内にクリアする`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);
