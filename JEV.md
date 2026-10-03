# Jevでプレイする

`--comparison` を付けると、issue #1の「初手ごとに同じ探索幅で見つけた20手の生存候補」から選ぶ比較モードになります。従来の標準Jev版とは候補生成条件が異なります。`--provider random` が同じ候補から均等ランダムで選ぶ対照です。実験・計測・再集計の手順は[比較実験の説明](verification/SURVIVAL-COMPARISON.md)を参照してください。

通常起動はローカル版です。`npm run jev`または`--provider jev`でJevを利用できます。`--hard`はJevでも指定できます。

## 接続設定

TypeSafe公式APIの仕様に対応しています。

- 公式手順: https://docs.typesafe.ai/introduction/quickstart
- 送信先: `https://api.typesafe.ai/v1/systemone`
- モデル: `jev-latest`（環境変数`JEV_MODEL`で変更可能）
- リクエスト: `state`とChoice型の`questions.move`
- 返答: `answers.move.choice`、`probabilities`、`confidence`

APIキーはローカルの環境変数へ設定してください。ゲームのJavaScriptやゲームサイトへは渡しません。
送信するのはプレイヤー座標、敵、弾、攻撃予告、ライフなどのゲーム状態と、ローカルで予測した候補の評価です。

macOS / bash / zsh:

```bash
# ここを自分のTypeSafe APIキーへ置き換えます。チャットへ貼る必要はありません。
export TYPESAFE_API_KEY='自分のAPIキー'

# API呼び出しの上限を明示し、まず30秒で試します。
npm run jev -- --time 30 --max-calls 500
```

Windows / PowerShell:

```powershell
# このPowerShellセッションの環境変数にだけ設定します。
$env:TYPESAFE_API_KEY = '自分のAPIキー'

# Jevが選んだ行動で、自動プレイを開始します。
npm run jev -- --time 30 --max-calls 500
```

既存の実行記録でJev APIへの接続成功を確認しています。短期予測を追加した版は模擬APIで検証し、追加の有料呼び出しはしていません。
公式ドキュメントの形式に基づき、リクエスト作成・返答処理・不正な返答の拒否・呼び出し上限を模擬APIで検証しています。
APIのエラー時に黙って標準ロジックへ切り替えることはありません。自動操作を停止し、原因を表示します。
`--max-calls`は送信回数の上限であり、金額の上限ではありません。失敗した送信も回数に含みます。自動再試行はしません。
料金は契約先の現在の料金表を確認してください。


## 短期予測による補助（標準）

```bash
npm run jev -- --hard --attempts 1 --max-calls 300
```

全経路を開始前に探索せず、判断ごとに20回先・最大24候補を予測します。
被弾数・残りライフ・予測生存時間で最良の候補より劣らず、評価コストが最良+10以内の行動だけをJevへ渡します。
候補が1つならAPIを呼びません。Jevの選択をローカル予測へも反映し、次の判断時に実ゲームとの一致を確認します。
`decisions.jsonl`の`selection`は`jev`または`planner-only`、`calls`は実際の送信回数です。
再試行で予測は作り直しますが、API呼び出し上限は全試行共通です。

既定の判断間隔は100msです。300msへ延ばすと回避の機会が減るので、精度を優先する場合は100msを使ってください。
`--depth`・`--width`で計算量を変更できます。予測範囲より先で行き詰まる可能性があり、全経路探索と同等の成功率は保証しません。
開始までの時間にはゲームルールの取得・ブラウザ起動・API通信も含まれます。

```bash
# 従来の、Jevだけが現在の状態から判断する方式
npm run jev -- --hard --jev-direct --attempts 1 --max-calls 300

# API料金なしで、候補の中で最も評価が低い行動を選ぶ模擬APIを検証
MONONOKE_ENGINE_DIR=/path/to/original/js/core node scripts/benchmark-jev.js

# 模擬APIを使ったブラウザ検証（有料APIは呼びません）
RUN_BROWSER_TESTS=1 node --test test/jev-browser.test.js
```

模擬APIの検証結果は実Jevの攻略率や通信時間を表すものではありません。

## 動作速度の調整

標準の探索幅を96から24へ減らしました。先読みの長さ20回・判断間隔100msは維持しています。
模擬APIではL/S・ライフ1・各敵5体・シード1/6/32652の6条件をすべて無被弾クリアしました。
少数の条件の検証であり、実Jevでの攻略率が変わらないことを保証するものではありません。

以前の探索幅へ戻す場合:

```bash
npm run jev -- --hard --attempts 1 --max-calls 300 --width 96
```

結果は `verification/jev-width24-benchmark.json`。実APIの通信時間・ブラウザ描画時間は含みません。


追加で、探索条件を変えずに敵のコピー処理を高速化しました。保存済みの成功ログ2件では合計583回の候補評価が完全一致し、同じ状態を使った比較で先読み計算を約9%短縮しました。詳細は `verification/JEV-EXACT-SPEED.md` を参照してください。
