import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,phone:string){
  if(test.info().project.name==='mobile'){const mobilePhones:Record<string,string>={'09011112222':'09055556666','09033334444':'09077778888','09033335555':'09077779999'};phone=mobilePhones[phone]??phone;}
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
  if(test.info().project.name==='mobile')await page.getByRole('button',{name:'メニュー',exact:true}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page).toHaveURL(/customer-login/);
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

test('supplier staff invitations, availability and customer support persist through the web',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await login(page,'09033335555');await page.getByLabel('利用モード').selectOption('supplier');
  await page.getByRole('button',{name:'申請・担当者・対応予定',exact:true}).click();
  await expect(page.getByRole('heading',{name:'担当者を招待',exact:true})).toBeVisible();
  const phone=test.info().project.name==='mobile'?'+819012345602':'+819012345601';
  await page.getByLabel('招待する電話番号',{exact:true}).fill(phone);
  await page.getByRole('button',{name:'招待コードを作成',exact:true}).click();
  await expect(page.getByLabel('招待コード',{exact:true}).last()).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  const invitation=page.locator('p').filter({hasText:phone}).filter({has:page.getByRole('button',{name:'招待を取り消す',exact:true})});
  await invitation.getByRole('button',{name:'招待を取り消す',exact:true}).click();
  await expect(page.locator('p').filter({hasText:phone})).toContainText('無効');
  await page.getByLabel('開始（日本時間）',{exact:true}).fill(localDate(new Date(Date.now()+70*86400000)));
  await page.getByLabel('終了（日本時間）',{exact:true}).fill(localDate(new Date(Date.now()+70*86400000+3600000)));
  const remove=page.getByRole('button',{name:'削除',exact:true});const count=await remove.count();
  await page.getByRole('button',{name:'対応時間を登録',exact:true}).click();await expect(remove).toHaveCount(count+1);
  await remove.last().click();await expect(remove).toHaveCount(count);
  await page.getByRole('button',{name:'お知らせ・お問い合わせ',exact:true}).click();
  const message='ブラウザからの安全管理についての問い合わせ '+test.info().project.name;
  await page.getByLabel('お問い合わせの種類',{exact:true}).selectOption('safety');await page.getByLabel('お問い合わせ内容',{exact:true}).fill(message);
  await page.getByRole('button',{name:'送信する',exact:true}).click();await expect(page.getByText(message,{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'お知らせ・お問い合わせ',exact:true}).click();await expect(page.getByText(message,{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});

test('supplier registration, document upload and review application persist',async({page})=>{
  const phone=test.info().project.name==='mobile'?'09088880002':'09088880001';
  await page.goto('/customer-login');await page.getByLabel('電話番号',{exact:true}).fill(phone);await page.getByRole('button',{name:'確認コードを送信',exact:true}).click();
  await expect(page.getByLabel('SMSの6桁の確認コード')).toBeVisible();const otp=await page.request.get('http://127.0.0.1:8095/__test/otp/'+encodeURIComponent('+81'+phone.slice(1)));
  await page.getByLabel('SMSの6桁の確認コード').fill((await otp.json()).code);await page.getByRole('button',{name:'ログイン',exact:true}).click();await expect(page).toHaveURL(/marketplace/);
  await page.getByLabel('姓',{exact:true}).fill('申請');await page.getByLabel('名',{exact:true}).fill('事業者');await page.getByLabel('住所',{exact:true}).fill('東京都千代田区1-1');await page.getByRole('button',{name:'登録する',exact:true}).click();await expect(page.getByRole('heading',{name:'顧客の登録',exact:true})).toHaveCount(0);
  await page.getByLabel('利用モード').selectOption('supplier');await page.getByLabel('事業者名',{exact:true}).fill('ブラウザ申請事業者 '+test.info().project.name);await page.getByLabel('所在地',{exact:true}).fill('東京都千代田区1-1');await page.getByRole('button',{name:'登録を申請',exact:true}).click();
  await page.getByRole('button',{name:'申請・担当者・対応予定',exact:true}).click();
  await page.getByLabel('事業分類',{exact:true}).fill('生活支援');await page.getByLabel('作業エリアコード（カンマ区切り）',{exact:true}).fill('13101');await page.getByLabel('営業時間',{exact:true}).fill('平日9時から18時');await page.getByLabel('保険・安全管理',{exact:true}).fill('賠償責任保険加入と訪問手順確認');await page.getByLabel('連絡先メール',{exact:true}).fill('supplier@example.test');await page.getByLabel('事業内容・訪問方法',{exact:true}).fill('高齢者の買い物や家事のお手伝いをします');
  const image=await page.request.get('http://127.0.0.1:8095/__test/document-image');await page.getByLabel('審査書類の写真（JPEG・PNG）',{exact:true}).setInputFiles({name:'review.jpg',mimeType:'image/jpeg',buffer:await image.body()});await expect(page.getByText('登録済みの書類: 1件',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'申請を提出',exact:true}).click();await expect(page.getByRole('status')).toHaveText('保存しました');
  await page.reload();await page.getByLabel('利用モード').selectOption('supplier');await page.getByRole('button',{name:'申請・担当者・対応予定',exact:true}).click();await expect(page.getByLabel('事業分類',{exact:true})).toHaveValue('生活支援');await expect(page.getByText('登録済みの書類: 1件',{exact:true})).toBeVisible();
});

test('admin supplier and service review plus independent dispute approval',async({page})=>{
  const project=test.info().project.name;const fixtures=await (await page.request.get('http://127.0.0.1:8095/__test/fixtures')).json();
  async function adminLogin(role:string){const email=fixtures[role+'_'+project].email;await page.goto('http://127.0.0.1:13002/login');await page.getByLabel(/^メールアドレス/).fill(email);await page.getByLabel(/^パスワード/).fill('correct horse battery staple');await page.getByRole('button',{name:'次へ',exact:true}).click();await expect(page.getByRole('heading',{name:'二段階認証',exact:true})).toBeVisible();const code=(await (await page.request.get('http://127.0.0.1:8095/__test/mfa/'+encodeURIComponent(email))).json()).code;await page.getByLabel(/^確認コード/).fill(code);await page.getByRole('button',{name:'確認してログイン',exact:true}).click();await expect(page).toHaveURL('http://127.0.0.1:13002/dashboard');await page.goto('http://127.0.0.1:13002/marketplace');await expect(page.getByRole('heading',{name:'暮らしの支援・審査と紛争',exact:true})).toBeVisible();}
  await adminLogin('operator');
  const supplier=page.getByRole('article').filter({has:page.getByRole('heading',{name:'ブラウザ申請事業者 '+project,exact:true})});await supplier.getByRole('button',{name:'申請・書類を確認',exact:true}).click();
  const application=page.locator('section').filter({has:page.getByRole('heading',{name:'ブラウザ申請事業者 '+project+'の申請内容',exact:true})});await application.getByRole('button',{name:'確認書類を表示',exact:true}).click();await expect(application.getByRole('link',{name:'確認書類を開く（有効期限あり）',exact:true})).toHaveAttribute('href',/^http:\/\/127\.0\.0\.1:8095\/v1\/evidence-blobs\//);
  await application.getByRole('combobox').selectOption('approved');await application.getByLabel('理由',{exact:true}).fill('登録内容と確認書類を照合しました');await application.getByRole('button',{name:'審査結果を保存',exact:true}).click();await expect(supplier).toContainText('承認済み');
  const supplierPhone=project==='mobile'?'09077778888':'09033334444';const service=page.getByRole('article').filter({has:page.getByRole('heading',{name:new RegExp('ブラウザ試験の訪問支援.*'+supplierPhone)})});await service.getByRole('combobox').selectOption('published');await service.getByLabel('審査理由',{exact:true}).fill('対応地域とサービス内容を確認しました');await service.getByRole('button',{name:'保存',exact:true}).click();await expect(service).toHaveCount(0);
  const dispute=page.getByRole('article').filter({has:page.getByRole('heading',{name:fixtures['dispute_'+project].title,exact:true})});await dispute.getByRole('button',{name:'作業内容・メッセージを確認',exact:true}).click();await expect(page.getByText('訪問の支援内容を確認してください',{exact:true})).toBeVisible();await dispute.getByRole('combobox').selectOption('resolved_cancelled');await dispute.getByLabel('理由',{exact:true}).fill('当事者の記録を照合して取消を提案します');await dispute.getByLabel('確認した作業記録・証拠',{exact:true}).fill('顧客と担当者の連絡履歴を個別に確認し、作業が完了していないことを記録しました');await dispute.getByRole('button',{name:'二次確認を依頼',exact:true}).click();await expect(dispute.getByRole('button',{name:'別の担当者の確認が必要です',exact:true})).toBeDisabled();
  if(project==='mobile')await page.getByRole('button',{name:'メニュー',exact:true}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();await expect(page).toHaveURL('http://127.0.0.1:13002/login');await adminLogin('reviewer');await dispute.getByRole('combobox').selectOption('yes');await dispute.getByLabel('確認理由',{exact:true}).fill('別担当として記録を確認し取消が妥当と判断しました');await dispute.getByRole('button',{name:'二次確認を保存',exact:true}).click();await expect(dispute).toHaveCount(0);
});
