import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,phone:string){
  if(test.info().project.name==='mobile')phone=phone==='09011112222'?'09055556666':'09077778888';
  await page.goto('/customer-login');await page.getByLabel('電話番号',{exact:true}).fill(phone);
  await page.getByRole('button',{name:'確認コードを送信',exact:true}).click();
  await expect(page.getByLabel('SMSの6桁の確認コード')).toBeVisible();
  const otp=await page.request.get('http://127.0.0.1:8095/__test/otp/'+encodeURIComponent('+81'+phone.slice(1)));
  await page.getByLabel('SMSの6桁の確認コード').fill((await otp.json()).code);
  await page.getByRole('button',{name:'ログイン',exact:true}).click();await expect(page).toHaveURL(/\/marketplace/);
}
function localDate(date:Date){return new Date(date.getTime()+9*3600000).toISOString().slice(0,16);}
test('customer login, catalog, post, history, cancellation, plans, and logout',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await login(page,'09011112222');
  await expect(page.getByRole('heading',{name:'毎日の暮らしに、頼れる支援を。'})).toBeVisible();
  await page.getByRole('button',{name:'サービスを見る',exact:true}).click();
  await page.getByRole('button',{name:'依頼内容を入力'}).first().click();
  await page.getByLabel('タイトル',{exact:true}).fill('ブラウザ通し試験の買い物依頼');
  await page.getByLabel('内容',{exact:true}).fill('玄関までの支援をお願いします');
  await page.getByLabel('現場住所',{exact:true}).fill('東京都千代田区1-1');
  await page.getByLabel('開始（日本時間）').fill(localDate(new Date(Date.now()+3*3600000)));
  await page.getByLabel('終了（日本時間）').fill(localDate(new Date(Date.now()+4*3600000)));
  await page.getByRole('button',{name:'依頼を投稿',exact:true}).click();
  await page.getByRole('button',{name:/ブラウザ通し試験の買い物依頼/}).first().click();
  await expect(page.getByRole('heading',{name:'ブラウザ通し試験の買い物依頼',exact:true})).toBeVisible();
  page.once('dialog',d=>d.accept('予定の変更'));
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();
  await expect(page.getByText('キャンセル',{exact:true}).first()).toBeVisible();
  await page.getByRole('link',{name:'会員プラン',exact:true}).last().click();
  await expect(page.getByRole('heading',{name:'お申込み受付準備中'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'ケア',exact:true})).toBeVisible();
  await page.screenshot({path:`test-results/customer-${test.info().project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  if(test.info().project.name==='mobile')await page.getByRole('button',{name:'メニュー',exact:true}).click();
  await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page).toHaveURL(/customer-login/);
});
test('supplier mode, service review submission, and tenant allowlist',async({page})=>{
  await login(page,'09033334444');
  await page.getByLabel('利用モード').selectOption('supplier');
  await expect(page.getByRole('heading',{name:'供給者ダッシュボード'})).toBeVisible();
  await page.getByRole('link',{name:'サービス',exact:true}).last().click();
  await page.getByLabel('名称',{exact:true}).fill('ブラウザ試験の訪問支援');
  await page.getByLabel('説明',{exact:true}).fill('予約に合わせてご訪問します');
  await page.getByLabel('対象地域コード（カンマ区切り）').fill('13101');
  await page.getByLabel('所要時間（分）').fill('60');
  await page.getByLabel('価格・見積方法').fill('作業内容を確認して見積');
  await page.getByRole('button',{name:'審査を申請'}).click();
  await expect(page.getByRole('heading',{name:'ブラウザ試験の訪問支援',exact:true}).first()).toBeVisible();
  await expect(page.getByText('審査中',{exact:true}).first()).toBeVisible();
  const denied=await page.request.get('/api/hd/admin/users');expect(denied.status()).toBe(403);
  await page.screenshot({path:`test-results/supplier-${test.info().project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('Google sign-in, phone verification and returning to the same account',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const subject=`browser-google-${test.info().project.name}`;
  // Google itself is a test adapter here; real signed JWTs are verified by the API.
  await fakeGoogle(page,subject);
  await page.goto('/customer-login');await page.getByRole('button',{name:'Gmail・Googleでログイン',exact:true}).click();await page.getByRole('button',{name:'Googleテストアカウント',exact:true}).click();await expect(page).toHaveURL(/\/marketplace/);
  await expect(page.getByRole('heading',{name:'顧客の登録',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'電話番号をSMSで確認',exact:true}).click();
  const phone=test.info().project.name==='mobile'?'09099990002':'09099990001';
  await page.getByLabel('電話番号',{exact:true}).fill(phone);await page.getByRole('button',{name:'確認コードを送信',exact:true}).click();
  await expect(page.getByLabel('SMSの6桁の確認コード')).toBeVisible();
  const otp=await page.request.get('http://127.0.0.1:8095/__test/otp/'+encodeURIComponent('+81'+phone.slice(1)));await page.getByLabel('SMSの6桁の確認コード').fill((await otp.json()).code);await page.getByRole('button',{name:'ログイン',exact:true}).click();await expect(page).toHaveURL(/\/marketplace/);
  await page.getByLabel('姓',{exact:true}).fill('Google');await page.getByLabel('名',{exact:true}).fill('利用者');await page.getByLabel('住所',{exact:true}).fill('東京都千代田区1-1');await page.getByRole('button',{name:'登録する',exact:true}).click();await expect(page.getByRole('heading',{name:'顧客の登録',exact:true})).toHaveCount(0);
  if(test.info().project.name==='mobile')await page.getByRole('button',{name:'メニュー',exact:true}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();
  await page.getByRole('button',{name:'Gmail・Googleでログイン',exact:true}).click();await page.getByRole('button',{name:'Googleテストアカウント',exact:true}).click();await expect(page).toHaveURL(/\/marketplace/);await expect(page.getByRole('heading',{name:'毎日の暮らしに、頼れる支援を。'})).toBeVisible();await expect(page.getByRole('heading',{name:'顧客の登録',exact:true})).toHaveCount(0);
  const cookies=await page.context().cookies();expect(cookies.filter(c=>c.name.endsWith('_at')||c.name.endsWith('_rt')).every(c=>c.httpOnly)).toBe(true);expect(errors).toEqual([]);
});

async function fakeGoogle(page:Page,subject:string) {
  await page.route('**/__test/google-token',async route=>{const res=await page.request.post('http://127.0.0.1:8095/__test/google-token',{data:route.request().postDataJSON()});await route.fulfill({response:res});});
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'application/javascript',body:`
    window.google={accounts:{id:{initialize:function(options){window.googleOptions=options;},renderButton:function(el){
      const button=document.createElement('button');button.textContent='Googleテストアカウント';button.onclick=async function(){
        const response=await fetch('/__test/google-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:window.googleOptions.nonce,subject:'${subject}'})});
        window.googleOptions.callback({credential:(await response.json()).token});
      };el.appendChild(button);
    }}}};` }));
}

test('Google login preserves the second-factor step',async({page})=>{
  const subject='browser-google-mfa-'+test.info().project.name;await fakeGoogle(page,subject);
  await page.goto('/customer-login');await page.getByRole('button',{name:'Gmail・Googleでログイン',exact:true}).click();await page.getByRole('button',{name:'Googleテストアカウント',exact:true}).click();await expect(page).toHaveURL(/login\?google=mfa/);
  await expect(page.getByRole('heading',{name:'二段階認証',exact:true})).toBeVisible();
  expect((await page.context().cookies()).some(c=>c.name.endsWith('_at'))).toBe(false);
  const otp=await page.request.get('http://127.0.0.1:8095/__test/mfa/'+subject);await page.getByLabel(/^確認コード/).fill((await otp.json()).code);
  await page.getByRole('button',{name:'確認してログイン',exact:true}).click();await expect(page).toHaveURL(/\/marketplace/);
  expect((await page.context().cookies()).some(c=>c.name.endsWith('_at') && c.httpOnly)).toBe(true);
});
