# issue #1: 共通の生存候補によるランダム／Jev比較

実装対象のmainは `acc1c84` です。実験ごとに対象コミット・コードdigest・原本ルールdigestをmanifestへ固定します。

## 候補の生成

合法な初手それぞれに独立した幅24の探索を割り当て、20手先に生存する経路を1つ以上発見したものだけを候補にします。途中クリアも含めます。探索途中の採点・枝刈りは共通です。死亡した枝や予算切れで20手未到達の枝は候補にしません。予測内で未発見でも、生存経路が存在しない証明にはなりません。

生存候補を作った後、Jevにだけ追加のコスト制限をかけることはありません。候補の経路数を選択確率にせず、重複のない初手から選びます。1手実行するごとに再予測し、終了までの全経路事前探索はしません。

候補1件ではAPI不要です。候補0件では探索で最も長く生存した枝の初手を選び、同率なら両方式共通のfallback乱数を使います。通常のランダム選択・fallback・ゲーム内部の乱数は独立しています。選択用シード・消費回数も記録します。

## 実行

```bash
# 通常ゲームで比較用ランダムを使う
npm start -- --provider random --hard --field S --selection-seed 1
# 同じ候補条件でJevを使う（従来のJev版は --comparison を付けない）
npm run jev -- --comparison --hard --field S --selection-seed 1 --max-calls 300
# 成功しても予定試行数を続ける。固定シードの比較は下の実験器を使う
npm start -- --provider random --hard --field S --attempts 5 --all-attempts

# API不要の原本シミュレーター機能確認（両方式各1試行、Jev側は模擬）
npm run compare:survival -- --seed-count 1 --repeats 1 --output runs/smoke
# 実Jevによる小規模計測：両方式各30試行、方式の順番を交互にする
npm run compare:survival -- --live --seed-count 30 --repeats 1 --max-calls 1000000 --output runs/pilot
# 原本上の本実験：100シード×5反復×2方式（計1,000試行）
npm run compare:survival -- --live --seed-count 100 --repeats 5 --max-calls 1000000 --output runs/full
# ブラウザ実時間の対応測定（計60試行）。任意シードの注入はしない
npm run compare:survival -- --mode browser --live --seed-count 30 --repeats 1 --max-calls 1000000 --output runs/browser-pilot
# ブラウザで本実験全体を行う場合（計1,000試行）
npm run compare:survival -- --mode browser --live --seed-count 100 --repeats 5 --max-calls 1000000 --output runs/browser-full
```

有料APIは `--live` を明示したときだけ呼びます。`--max-calls` は実験全体の送信上限で、失敗した送信も数えます。金額の上限ではありません。API使用量をまずpilotで見積もってください。timeは30または120で、条件ごとに別のディレクトリを使います。30秒で差が判定しにくければ `--time 120` で追加実験を行い、理由を報告します。

ブラウザではゲームの設定UIを操作し、ゲームが生成したシードを観測して保存します。「同条件で再出陣」または中断後の「やり直す」で同じシードを再実行します。ゲームのソース・ライフ・乱数を直接変更しません。ブラウザでの `--start-seed` 指定は使いません。新しいシードが重複した場合は明示的に停止し、別の独立シードとして数えません。測定は同じ機材で順次実行し、並列にしないでください。

## 成果物・再集計

敵構成は `--enemies '{"CHASER":10,"DASHER":10,"JAMMER":10}'` のように指定できます。省略した敵は0体です。ゲームの通常設定に合わせ各10体・合計30体まで検証し、ブラウザでも設定UIから指定します。S・30秒を固定して研究を続ける場合は `npm run study:survival -- runs/study-custom --enemies '{"CHASER":10,"DASHER":10,"JAMMER":10}' --fixed-time` を使います。`--fixed-time` は120秒への自動拡張を無効にします。

API不要の敗北条件探索は `node scripts/find-failure-cases.js runs/failure-search`、発見済みの構成を独立シードで確認する場合は `node scripts/find-failure-cases.js runs/failure-confirm --confirm-profile '{"CHASER":10,"DASHER":10,"JAMMER":10}'` です。確認はゲームシード3～12と選択用シード11・29を組み合わせます。同じゲームシードの2回を独立した20種類の初期条件とはみなしません。

全段階を順番に実行する場合は `MONONOKE_PYTHON=.venv/bin/python npm run study:survival -- runs/study` を使います。30秒の原本pilot（60試行）から使用量を見積もり、ブラウザpilot（60試行）、原本の本実験（1,000試行）へ進みます。30秒本実験で両方式のクリア率が95%以上、かつ生存差の区間が0を含む場合は、理由を記録し120秒のブラウザpilotと原本本実験を追加します。各段階の上限はAPI100万回、再試行なし。`study.json` に進捗を保存し、終了・中断時に `STUDY.md` を出力します。

この手順で生存性能は本実験1,000試行、ブラウザ実時間は各時間条件60試行を評価します。すべての1,000試行でブラウザ時間も測る場合は上記の `--mode browser` の本実験コマンドを指定してください。

- `decisions/*.jsonl`: 候補・選択理由・探索内訳・タイミング・API使用量。失敗した判断も記録。
- `trials.json`, `trials.csv`: 成功・敗北・中断・未開始を区別した試行結果。
- `manifest.json`: コミット・ルール・設定・モデル・日時・Node/ブラウザ・OS/機材・準備時間。
- `aggregate.json`, `REPORT.md`: 平均・中央値・下位10%、クリア率・正常終了率、実時間、予測/API時間の中央値・p95・合計、候補0/1/複数割合。
- `comparison.svg`, `comparison.png`: Matplotlibによる比較グラフ。

グラフにはPythonとMatplotlibが必要です。別のPythonを使う場合は `MONONOKE_PYTHON=/path/to/python` を指定します。グラフ不要なら `--no-plot` を指定できます。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install matplotlib
MONONOKE_PYTHON=.venv/bin/python npm run report:survival -- runs/full
```

生存時間・クリア率・実時間の差は同じシードと反復を対応付け、シードごとの平均差を単位に2,000回bootstrapします。各シードの5反復を独立した500シードとはみなしません。両方式がクリアした対応試行の実時間差も別に示します。中断による欠測や少数シードでは判断を断定しません。

ブラウザ実時間は最初のゲーム状態検知からクリア／敗北確定の検知までです。開始前のルール取得・ブラウザ起動は準備時間へ分離し、最初に観測したゲーム内時間も記録します。シミュレーター実行時間はブラウザ実時間と別の指標です。クリアは制限時間で打ち切った観測であり、限界生存時間ではありません。この方式はデバッガでゲームを止めるため、人間と同じリアルタイム条件の攻略能力を示すものではありません。

APIのタイムアウト・HTTP異常・不正返答・上限は敵による敗北と区別します。再試行・ランダムへの代替はしません。認証／支払拒否（401/402/403）、全体上限、Jevの3試行連続で同じ中断理由が生じた場合は残りを未開始として止めます。中断時点のゲーム内時間・実時間・通信回数・取得できた入力トークンを残し、集計から黙って除外しません。APIキーやAuthorizationは記録しません。

## 1時間を上限にした並列比較

100ゲームシードに両方式を1回ずつ、計200試行。独立したシード群を4つのNodeプロセスへ分配し、各シードの両方式は順次実行する。候補生成・乱数・ゲーム条件は変更しない。

```sh
npm run compare:parallel -- --live --output runs/parallel-new --workers 4 --minutes 60 --seed-count 100 --repeats 1
```

既定の相手はCHASER/DASHER/JAMMER各10体、S盤面・30秒・残機1。以前の各方式5反復・1000試行から、利用者の希望により各方式1回・200試行へ変更した。最大4件のAPIリクエストが同時進行する。APIを再試行したり模擬APIへ置き換えたりしない。

上限の30秒前に停止シグナルを送り、ログと集計を保存する。終了処理が遅れた場合は1時間を厳密に保証しない。1時間以内に200試行が終わらない場合は中断と未開始を明記する。並列実行中の時間は単独プレイの速度評価に使わない。従来のブラウザ60試行はこの時間制限付き実行には含めない。各shardの試行・JSONLを保持し、集約時にシード番号・対応IDを全体で一意にする。
