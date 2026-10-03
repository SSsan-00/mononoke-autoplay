import { fixtureRoute } from './fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { playSession } from '../src/cli.js';
import { HeuristicPolicy } from '../src/policy.js';
import { JevPolicy } from '../src/jev.js';

const URL = 'https://aigengames.pages.dev/Games/SurviveLimitMononoke/';
const enabled = process.env.RUN_BROWSER_TESTS === '1';


test('ブラウザ上で無改変のゲームを開始・状態取得・自動操作・結果表示する', {skip:!enabled,timeout:180000}, async () => {
  const browser=await chromium.launch({headless:true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
    args:process.env.TEST_SWIFTSHADER==='1' ? ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : [],
  });
  const records=[];
  const output=path.resolve('verification');
  await mkdir(output,{recursive:true});
  try {
    for (const scenario of ['chaser','mixed']) {
      const page=await browser.newPage({viewport:{width:400,height:700}});
      const pageErrors=[];
      page.on('pageerror',e=>pageErrors.push(e.message));
      await fixtureRoute(page);
      await page.goto(URL,{waitUntil:'networkidle'});
      const timeButton=page.getByRole('button',{name:/^刻:/});
      while(!(await timeButton.innerText()).includes('30秒')) await timeButton.click();
      if(scenario==='mixed') {
        for(const name of ['天狗','から傘','輪入道','豆腐小僧','塗壁']) {
          await page.locator('.enemy-row').filter({hasText:name}).getByRole('button',{name:'+',exact:true}).click();
        }
      }
      let first=null;
      const positions=new Set();
      let decisions=0;
      let lastReported=-5000;
      const summary=await playSession(page,new HeuristicPolicy(),{
        onState:state=>{
          if(!first) first=state;
          positions.add(`${state.player.x},${state.player.y}`);
          if(state.elapsedMs-lastReported>=5000 || state.status!=='playing') {
            console.log(`${scenario}: ${(state.elapsedMs/1000).toFixed(1)}s, ${state.status}, lives=${state.lives}, decisions=${decisions}`);
            lastReported=state.elapsedMs;
          }
        },
        onDecision:()=>{decisions++;},
      });
      assert.ok(['cleared','failed'].includes(summary.status));
      assert.ok(decisions>5);
      assert.ok(positions.size>2,'入力によってプレイヤーが複数のマスへ移動する');
      assert.equal(first.enemies.length,scenario==='mixed'?6:1);
      await page.getByRole('button',{name:'同条件で再出陣',exact:true}).waitFor({timeout:15000});
      await page.screenshot({path:path.join(output,`${scenario}-result.png`),fullPage:true});
      assert.deepEqual(pageErrors,[]);
      const record={scenario,transport:process.env.MONONOKE_FIXTURE?'unchanged downloaded public resources':'live public URL',summary,distinctPositions:positions.size,pageErrors};
      records.push(record);
      console.log(JSON.stringify(record));
      await page.close();
    }
    await writeFile(path.join(output,'browser-results.json'),JSON.stringify(records,null,2));
  }finally{await browser.close();}
});

test('敗北の終了判定とJevエラー後の停止解除', {skip:!enabled,timeout:120000}, async () => {
  const browser=await chromium.launch({headless:true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
    args:process.env.TEST_SWIFTSHADER==='1' ? ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] : [],
  });
  const output=path.resolve('verification');
  const records=[];
  try{
    const errorPage=await browser.newPage({viewport:{width:400,height:700}});
    await fixtureRoute(errorPage);
    await errorPage.goto(URL,{waitUntil:'networkidle'});
    const failingPolicy=new JevPolicy({apiKey:'test-key',fetchImpl:async()=>({ok:false,status:401})});
    await assert.rejects(playSession(errorPage,failingPolicy),/HTTP 401/);
    assert.equal(await errorPage.evaluate(()=>1),1,'エラー後にもページのJavaScriptが動く');
    assert.equal(failingPolicy.calls,1);
    records.push({scenario:'jev-error-cleanup',mockApi:true,httpStatus:401,debuggerResumed:true});
    console.log('Jev error: HTTP 401を処理し、デバッガ停止を解除しました');
    await errorPage.close();

    const page=await browser.newPage({viewport:{width:400,height:700}});
    await fixtureRoute(page);
    await page.goto(URL,{waitUntil:'networkidle'});
    const life=page.getByRole('button',{name:/^命:/});
    while(!(await life.innerText()).includes('×1')) await life.click();
    for(const [name,additions] of [['化け狸',9],['天狗',10],['輪入道',10]]) {
      for(let i=0;i<additions;i++) await page.locator('.enemy-row').filter({hasText:name}).getByRole('button',{name:'+',exact:true}).click();
    }
    let lastStatus='';
    const summary=await playSession(page,new HeuristicPolicy(),{onState:s=>{
      if(s.status!==lastStatus){console.log(`failure scenario: ${s.status}, ${(s.elapsedMs/1000).toFixed(1)}s`);lastStatus=s.status;}
    }});
    assert.equal(summary.status,'failed');
    await page.getByRole('button',{name:'同条件で再出陣',exact:true}).waitFor({timeout:15000});
    await page.screenshot({path:path.join(output,'failed-result.png'),fullPage:true});
    records.push({scenario:'failed-result',enemies:30,initialLives:1,summary});
    await page.close();
    await mkdir(output,{recursive:true});
    await writeFile(path.join(output,'cleanup-results.json'),JSON.stringify(records,null,2));
    console.log(JSON.stringify(records));
  }finally{await browser.close();}
});
