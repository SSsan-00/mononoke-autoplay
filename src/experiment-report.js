import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { distribution, quantile } from './experiment.js';
import { SelectionRandom } from './survival.js';

export function pairedDifference(records, metric, { bothCleared = false, bootstrapSamples = 2000 } = {}) {
  const pairs = new Map();
  for (const record of records) {
    if (!['cleared', 'failed'].includes(record.status)) continue;
    const pair = pairs.get(record.pairId) ?? {};
    pair[record.method === 'random' ? 'random' : 'other'] = record;
    pairs.set(record.pairId, pair);
  }
  const clusters = new Map();
  let pairCount = 0;
  for (const { random, other } of pairs.values()) {
    if (!random || !other || (bothCleared && (random.status !== 'cleared' || other.status !== 'cleared'))) continue;
    const a = metric(random), b = metric(other);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const key = random.challenge.seed;
    if (key !== other.challenge.seed) throw new Error('対応付けた試行のゲームシードが一致しません。');
    const values = clusters.get(key) ?? [];
    values.push(b - a); clusters.set(key, values); pairCount++;
  }
  const means = [...clusters.values()].map(values => distribution(values).mean);
  if (!means.length) return { pairCount, seedCount: 0, mean: null, ci95: null };
  if (means.length === 1) return { pairCount, seedCount: 1, mean: means[0], ci95: null, limited: true };
  const rng = new SelectionRandom(31783), samples = [];
  for (let i = 0; i < bootstrapSamples; i++) {
    let sum = 0;
    for (let n = 0; n < means.length; n++) sum += rng.choose(means);
    samples.push(sum / means.length);
  }
  return { pairCount, seedCount: means.length, mean: distribution(means).mean,
    ci95: [quantile(samples, 0.025), quantile(samples, 0.975)],
    limited: means.length < 2, bootstrapSamples, bootstrapSeed: 31783 };
}

export function analyzeTrials(records, rawTimings = {}) {
  const methods = {};
  for (const method of new Set(records.map(r => r.method))) {
    const all = records.filter(r => r.method === method);
    const attempted = all.filter(r => r.status !== 'not-started');
    const normal = all.filter(r => ['cleared', 'failed'].includes(r.status));
    const candidates = { zero: 0, one: 0, multiple: 0 };
    for (const r of all) for (const key of Object.keys(candidates)) candidates[key] += r.candidateCounts?.[key] ?? 0;
    const candidateN = Object.values(candidates).reduce((a, b) => a + b, 0);
    const abortReasons = {};
    for (const r of all.filter(r => r.status === 'aborted')) abortReasons[r.abortReason] = (abortReasons[r.abortReason] ?? 0) + 1;
    const timings = rawTimings[method] ?? {};
    methods[method] = { scheduled: all.length, attempted: attempted.length, normal: normal.length,
      aborted: all.filter(r => r.status === 'aborted').length,
      notStarted: all.filter(r => r.status === 'not-started').length, abortReasons,
      normalCompletionRate: attempted.length ? normal.length / attempted.length : null,
      clearRate: normal.length ? normal.filter(r => r.status === 'cleared').length / normal.length : null,
      clearRateOfAttempted: attempted.length ? normal.filter(r => r.status === 'cleared').length / attempted.length : null,
      survivalSeconds: distribution(normal.map(r => r.survivedMs / 1000)),
      realElapsedMs: distribution(normal.map(r => r.realElapsedMs).filter(Number.isFinite)),
      simulatorElapsedMs: distribution(normal.map(r => r.simulatorElapsedMs).filter(Number.isFinite)),
      realToGameRatio: distribution(normal.map(r => r.realToGameRatio).filter(Number.isFinite)),
      predictionMs: distribution(timings.prediction ?? []), apiMs: distribution(timings.api ?? []),
      calls: all.reduce((sum, r) => sum + (r.calls ?? 0), 0), inputTokens: all.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      candidateCounts: candidates,
      candidateShares: Object.fromEntries(Object.entries(candidates).map(([key, n]) => [key, candidateN ? n / candidateN : null])) };
  }
  return { methods, paired: {
    direction: 'Jev (or mock-Jev) minus random; paired by repetition, clustered by game seed',
    survivalSeconds: pairedDifference(records, r => r.survivedMs / 1000),
    clearRate: pairedDifference(records, r => Number(r.status === 'cleared')),
    realElapsedMs: pairedDifference(records, r => r.realElapsedMs),
    bothClearedRealElapsedMs: pairedDifference(records, r => r.realElapsedMs, { bothCleared: true }),
  } };
}

const f = value => value == null ? '未測定' : Number(value).toFixed(3);
const pct = value => value == null ? '未測定' : `${(value * 100).toFixed(1)}%`;

export async function writeExperimentReport(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const records = JSON.parse(await readFile(path.join(directory, 'trials.json'), 'utf8'));
  const timings = {};
  for (const record of records) {
    if (!record.logFile) continue;
    timings[record.method] ??= { prediction: [], api: [] };
    const lines = createInterface({ input: createReadStream(path.join(directory, record.logFile)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const sample = JSON.parse(line);
      if (Number.isFinite(sample.predictionMs)) timings[record.method].prediction.push(sample.predictionMs);
      if (sample.apiAttempted && Number.isFinite(sample.apiMs)) timings[record.method].api.push(sample.apiMs);
    }
  }
  const aggregate = { manifest, ...analyzeTrials(records, timings) };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'aggregate.json'), JSON.stringify(aggregate, null, 2));
  const columns = ['trialId', 'pairId', 'gameSeed', 'seedIndex', 'repeat', 'method', 'status', 'abortReason', 'selectionSeed', 'survivedMs', 'partialSurvivedMs',
    'realElapsedMs', 'simulatorElapsedMs', 'calls', 'inputTokens', 'preparationMs'];
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  await writeFile(path.join(directory, 'trials.csv'), [columns.join(','), ...records.map(r => columns.map(k => escape(r[k])).join(','))].join('\n') + '\n');
  let report = `# ランダム選択と${manifest.live ? '実Jev' : '模擬Jev'}の生存候補比較\n\n`;
  report += `計測経路: **${manifest.mode}**。対象コミット: \`${manifest.commit}\`。コードdigest: \`${manifest.codeDigest}\`。原本ルールdigest: \`${manifest.rulesDigest}\`。日時: ${manifest.startedAt}。\n\n`;
  report += `予定${manifest.plannedTrials}試行、記録${records.length}試行。S盤面・ライフ1・${manifest.time}秒、深さ20・初手ごとの幅24・判断間隔100ms。敵構成: \`${JSON.stringify(manifest.profile.enemies)}\`。両方式の候補生成・候補0/1件の処理は共通です。\n\n`;
  if (manifest.parallelWorkers) report += `**${manifest.parallelWorkers}プロセスの並列実行、上限${manifest.timeLimitMinutes}分。** 計算・API時間は同時実行による競合を含むため、単独プレイの速度とは比較しません。時間上限で残った試行は未開始／中断と区別し、早く終わる試行が偏って残る可能性があります。全予定試行を完了するまで性能差の確定結果として扱いません。\n\n`;
  if (!manifest.live) report += '**模擬APIの機能検証です。実Jevの性能・通信時間の評価には使えません。**\n\n';
  report += '| 方式 | 正常終了 / 試行済み | 中断 | 未開始 | クリア率（正常終了のみ） | 生存平均 / 中央値 / 下位10%（秒） | ブラウザ実時間平均（秒） | API回数 | 入力トークン |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const [method, m] of Object.entries(aggregate.methods)) report += `| ${method} | ${m.normal}/${m.attempted} | ${m.aborted} | ${m.notStarted} | ${pct(m.clearRate)} | ${f(m.survivalSeconds.mean)} / ${f(m.survivalSeconds.median)} / ${f(m.survivalSeconds.p10)} | ${f(m.realElapsedMs.mean == null ? null : m.realElapsedMs.mean / 1000)} | ${m.calls} | ${m.inputTokens} |\n`;
  report += '\n| 方式 | 予測時間 合計 / 中央値 / p95（ms） | API時間 合計 / 中央値 / p95（ms） | 候補0 / 1 / 複数 | 実時間÷ゲーム内時間 平均 |\n|---|---:|---:|---:|---:|\n';
  for (const [method, m] of Object.entries(aggregate.methods)) report += `| ${method} | ${f(m.predictionMs.total)} / ${f(m.predictionMs.median)} / ${f(m.predictionMs.p95)} | ${f(m.apiMs.total)} / ${f(m.apiMs.median)} / ${f(m.apiMs.p95)} | ${pct(m.candidateShares.zero)} / ${pct(m.candidateShares.one)} / ${pct(m.candidateShares.multiple)} | ${f(m.realToGameRatio.mean)} |\n`;
  report += '\n## 対応付きの差（Jev側 − ランダム）\n\n| 指標 | 平均差 | シード単位bootstrap 95%区間 | 対応試行数 | 独立シード数 |\n|---|---:|---:|---:|---:|\n';
  for (const [key, m] of Object.entries(aggregate.paired)) if (typeof m === 'object') report += `| ${key} | ${f(m.mean)} | ${m.ci95 ? m.ci95.map(f).join(' ～ ') : '未測定'} | ${m.pairCount} | ${m.seedCount} |\n`;
  report += '\n同じシードの反復を独立した初期条件として扱わず、対応する正常終了試行の差をシードごとに平均し、シードを再標本化します。シードが1件だけなら区間は不確実性を評価できません。区間が0を含む差は方向を断定しません。中断による欠測が偏る可能性もあります。\n\n';
  report += '## 計測範囲と制約\n\n- クリアは制限時間で打ち切られた観測です。限界生存時間ではありません。\n- 生存候補は少なくとも1つの経路を探索で発見した行動です。その後の選択の生存を保証しません。予算切れ・未発見を不可能の証明と扱いません。\n- 中断は敗北として扱わず、生存時間の完全な観測から外します。件数・理由・中断時点はtrials.json/CSVに保持します。未開始試行も別記します。\n- 実時間は最初のゲーム状態検知から終了確定の検知までで、計算・通信・操作待ちを含みます。検知以前のゲーム内時間はfirstObservedGameMsに記録します。準備時間は別記します。\n- simulator経路のsimulatorElapsedMsはブラウザ実時間ではありません。経路を混ぜて時間比較しません。\n- 同じシードの両方式クリア試行の時間差も示します。早い敗北による短時間を優位と判断しません。\n- デバッガ停止方式であり、人間と同じリアルタイム条件の攻略能力を示しません。\n- API再試行・失敗後のランダム代替は行いません。認証・支払拒否（HTTP 401/402/403）は残りを未開始として止めます。\n- raw JSONL、trials.json/CSV、manifest.jsonから npm run report:survival -- <出力ディレクトリ> で再集計できます。\n\n';
  if (manifest.stoppedReason) report += `**実行停止理由: ${manifest.stoppedReason}**。予定試行を完了したとは扱いません。\n\n`;
  for (const [method, m] of Object.entries(aggregate.methods)) report += `${method} 中断理由: \`${JSON.stringify(m.abortReasons)}\`。\n\n`;
  report += '![比較グラフ](comparison.svg)\n\n認証・支払拒否・上限以外も、Jevの3試行連続で同じ中断理由が生じた場合は残りを未開始として止めます。\n';
  await writeFile(path.join(directory, 'REPORT.md'), report);
  return aggregate;
}
