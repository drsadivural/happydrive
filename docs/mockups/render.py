from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import random
P=Path(__file__).resolve().parent; A=P.parent/'assets'
ref=Image.open(A/'logo-reference-original.png').convert('RGB')
ref.crop((65,35,850,840)).resize((1024,1024)).save(A/'app-icon-reference.png')
word=Image.open(A/'ecosystem-reference-original.png').convert('RGB').crop((45,22,332,123))
word.save(A/'happy-drive-wordmark-reference.png')
FONT=str(A/'NotoSansJP-VF.ttf')
def F(n):
 f=ImageFont.truetype(FONT,n); f.set_variation_by_axes([500]); return f
W,H=780,1688
NAVY='#091d47'; BLUE='#0879f9'; GREEN='#159a60'; MUTED='#64748b'; BG='#f5f8fc'; BORDER='#e2eaf4'

def canvas(title, active):
 im=Image.new('RGB',(W,H),'white');d=ImageDraw.Draw(im)
 d.rectangle((0,0,W,H),fill=BG);d.rounded_rectangle((12,12,W-12,H-12),radius=60,fill='white')
 d.text((70,42),'9:41',font=F(27),fill=NAVY);d.ellipse((629,52,650,73),fill=NAVY);d.rectangle((661,52,695,72),fill=NAVY);d.rounded_rectangle((706,51,740,73),radius=5,outline=NAVY,width=3)
 d.text((48,113),title,font=F(47),fill=NAVY,stroke_width=0)
 d.line((38,1530,742,1530),fill=BORDER,width=2)
 labels=['ホーム','配達','案件','学ぶ','マイページ']; icons=['●','■','◆','▤','●']
 for i,(label,ic) in enumerate(zip(labels,icons)):
  x=77+i*147; col=BLUE if i==active else MUTED
  d.text((x,1550),ic,font=F(40),fill=col,anchor='mt');d.text((x,1612),label,font=F(20),fill=col,anchor='mt')
 return im,d

def rr(d,box,fill='white',outline=None,r=25,w=2):d.rounded_rectangle(box,radius=r,fill=fill,outline=outline,width=w)
def txt(d,xy,s,n=27,color=NAVY):d.text(xy,s,font=F(n),fill=color)
def pill(d,box,s,fill=BLUE,color='white',n=25):rr(d,box,fill,r=25);d.text(((box[0]+box[2])/2,(box[1]+box[3])/2),s,font=F(n),fill=color,anchor='mm')
def logo(im,box):
 src=Image.open(A/'happy-drive-wordmark-reference.png').convert('RGB');src.thumbnail((box[2]-box[0],box[3]-box[1]));im.paste(src,(box[0],box[1]))
def mapdraw(d,box,route=True):
 x,y,X,Y=box;rr(d,box,'#e9f3f6',r=27)
 random.seed(4)
 for i in range(9):
  xx=x+30+i*(X-x-40)//8;d.line((xx,y+8,xx+random.randrange(-80,100),Y-8),fill='#ffffff',width=17)
 for i in range(8):
  yy=y+25+i*(Y-y-35)//7;d.line((x+8,yy,X-8,yy+random.randrange(-70,70)),fill='#ffffff',width=13)
 d.polygon([(X-175,y+8),(X-10,y+8),(X-10,y+130),(X-90,y+100)],fill='#c7e4ef')
 if route:
  points=[(x+80,Y-85),(x+190,Y-195),(x+330,Y-165),(x+430,Y-310),(X-100,y+90)]
  d.line(points,fill=BLUE,width=12,joint='curve')
  for j,(px,py) in enumerate(points[1:],1):
   d.ellipse((px-26,py-26,px+26,py+26),fill=BLUE,outline='white',width=5);d.text((px,py+1),str(j),font=F(21),fill='white',anchor='mm')

def save(name,im):im.save(P/name,optimize=True)

im,d=canvas('おはようございます',0);logo(im,(45,185,500,315));txt(d,(47,300),'今日の予定を確認して、出発しましょう',23,MUTED)
rr(d,(38,365,742,610),BLUE);txt(d,(68,393),'本日の予定',26,'#dceeff');txt(d,(68,445),'配送  12件     案件  2件',38,'white');txt(d,(68,525),'予定報酬  ¥8,400',30,'white')
rr(d,(38,644,742,1000),outline=BORDER);txt(d,(65,675),'本日のルート',33);mapdraw(d,(60,740,720,970))
txt(d,(45,1030),'近くのHappy案件',34);rr(d,(38,1092,742,1260),outline=BORDER);txt(d,(68,1115),'買い物付き添い',31);txt(d,(68,1173),'横浜市中区  •  30分  •  1.2 km',23,MUTED);pill(d,(510,1150,710,1210),'¥900',GREEN)
rr(d,(38,1280,742,1450),outline=BORDER);txt(d,(68,1305),'道路状況の確認',31);txt(d,(68,1360),'横浜市西区  •  20分  •  2.1 km',23,MUTED);pill(d,(510,1350,710,1410),'¥600',BLUE);save('01-home.png',im)

im,d=canvas('配達ルート',1);pill(d,(45,200,390,270),'＋ 配達先を追加');pill(d,(408,200,735,270),'住所を一括取込','#e8f2ff',BLUE)
mapdraw(d,(38,302,742,900));rr(d,(55,326,432,398));txt(d,(77,344),'12件 • 約4時間20分',25);rr(d,(38,934,742,1410),outline=BORDER);txt(d,(62,958),'最適化された順番',32)
for j,(name,time) in enumerate([('山下町 1-2-3','10:00–10:20'),('港北区新横浜 2-4','10:45–11:00'),('神奈川区栄町 4-9','11:30–11:45')]):
 yy=1035+j*106;d.ellipse((65,yy,119,yy+54),fill=BLUE);txt(d,(83,yy+10),str(j+1),24,'white');txt(d,(140,yy),name,25);txt(d,(140,yy+42),time,22,MUTED)
pill(d,(65,1430,715,1508),'ルートを開始');save('02-delivery-route.png',im)

im,d=canvas('配達先の詳細',1);rr(d,(38,195,742,540),outline=BORDER);pill(d,(62,225,200,276),'配達中','#e8f2ff',BLUE,22);txt(d,(62,305),'山下町 1-2-3',36);txt(d,(62,372),'神奈川県横浜市中区山下町 1-2-3',22,MUTED);txt(d,(62,435),'指定時間  10:00–10:20',25);mapdraw(d,(38,565,742,1015),False)
rr(d,(38,1040,742,1315),outline=BORDER);txt(d,(65,1065),'配達メモ・受け渡し',29);txt(d,(65,1123),'置き配不可 • 受付でお渡し',23,MUTED);txt(d,(65,1180),'荷物番号  HD-2026-0142',23,MUTED)
pill(d,(55,1350,726,1420),'Appleマップで案内');pill(d,(55,1435,726,1508),'配達を完了する',GREEN);save('03-delivery-proof.png',im)

im,d=canvas('案件を探す',2);rr(d,(38,205,742,278),outline=BORDER);txt(d,(64,224),'場所・キーワードで検索',26,MUTED)
for i,(s,c) in enumerate([('すべて',BLUE),('生活支援',GREEN),('企業依頼','#8155d8'),('地域情報','#ed8b21')]):pill(d,(38+i*178,302,205+i*178,360),s,c,'white',20)
for i,(name,org,detail,money) in enumerate([('買い物付き添い','地域サポート事業者','本日 15:00 • 30分 • 1.2 km','¥900'),('書類の回収','市内企業','本日 16:00 • 25分 • 2.8 km','¥850'),('道路状況の撮影','地域調査会社','明日 10:00 • 20分 • 3.1 km','¥600'),('高齢者の見守り','生活支援事業者','明日 13:00 • 40分 • 1.9 km','¥1,500')]):
 yy=390+i*274;rr(d,(38,yy,742,yy+249),outline=BORDER);pill(d,(58,yy+22,231,yy+70),org,'#ecf7f2',GREEN,18);txt(d,(60,yy+88),name,31);txt(d,(60,yy+140),detail,21,MUTED);pill(d,(530,yy+169,713,yy+224),money,BLUE,'white',24)
save('04-job-search.png',im)

im,d=canvas('案件の詳細',2);rr(d,(38,205,742,395),GREEN);txt(d,(67,235),'生活サポート',24,'white');txt(d,(67,289),'買い物付き添い',39,'white');txt(d,(67,351),'横浜市中区  •  1.2 km',24,'white')
rr(d,(38,425,742,661),outline=BORDER);txt(d,(65,448),'報酬  ¥900',35);txt(d,(65,512),'本日 15:00–15:30  /  所要30分',24);txt(d,(65,565),'依頼元  地域サポート事業者',23,MUTED)
rr(d,(38,684,742,1080),outline=BORDER);txt(d,(65,713),'業務内容',31);txt(d,(65,780),'近くのスーパーでの買い物に付き添い、',24);txt(d,(65,825),'依頼者を安全にご案内します。',24);txt(d,(65,895),'必要なスキル  生活支援講習',23);txt(d,(65,954),'集合場所  受諾後に表示',23)
rr(d,(38,1102,742,1332),outline=BORDER);txt(d,(65,1134),'受諾前に確認',29);txt(d,(65,1190),'仕事内容・報酬・キャンセル条件を確認',23,MUTED)
pill(d,(55,1398,726,1508),'内容を確認して受諾');save('05-job-detail.png',im)

im,d=canvas('業務を進める',2);pill(d,(42,205,285,263),'実行中',GREEN);txt(d,(42,300),'買い物付き添い',38);txt(d,(42,372),'進行状況  3 / 5',24,MUTED)
steps=[('本人確認・あいさつ',True),('依頼内容を確認',True),('買い物に付き添う',True),('集合場所に戻る',False),('完了報告を送る',False)]
for j,(s,done) in enumerate(steps):
 yy=450+j*165;rr(d,(38,yy,742,yy+140),outline=BORDER);d.ellipse((65,yy+43,119,yy+97),fill=GREEN if done else '#d6e3f0');txt(d,(81,yy+50),'✓' if done else str(j+1),26,'white');txt(d,(143,yy+34),s,29);txt(d,(143,yy+82),'完了' if done else '未完了',21,GREEN if done else MUTED)
pill(d,(55,1380,726,1498),'次の手順へ',BLUE);save('06-job-workflow.png',im)

im,d=canvas('完了報告',2);d.ellipse((310,205,470,365),fill='#ddf6e9');txt(d,(352,240),'✓',78,GREEN);txt(d,(238,402),'お疲れさまでした',37);txt(d,(83,470),'実施内容を記録して報告してください',25,MUTED)
rr(d,(38,550,742,795),outline=BORDER);txt(d,(65,581),'実施時間',29);txt(d,(65,646),'15:02–15:34  （32分）',27);rr(d,(38,824,742,1106),outline=BORDER);txt(d,(65,855),'報告内容',29);txt(d,(65,918),'買い物付き添いを完了しました',23,MUTED)
pill(d,(55,1145,726,1215),'＋ 写真を追加','#e8f2ff',BLUE);txt(d,(62,1255),'依頼先の個人情報は撮影しないでください',19,MUTED);pill(d,(55,1390,726,1508),'完了報告を送信',GREEN);save('07-completion.png',im)

im,d=canvas('マイページ',4);logo(im,(45,202,420,300));txt(d,(45,315),'山田 太郎  •  ★ 4.8',30);rr(d,(38,395,742,640),BLUE);txt(d,(67,421),'今月の報酬',25,'white');txt(d,(67,472),'¥36,450',54,'white');txt(d,(67,566),'完了案件 24件',24,'white')
for j,s in enumerate(['報酬・振込履歴','実績・評価','資格・講習','通知・メッセージ','アカウント・設定','ヘルプ・お問い合わせ']):
 yy=670+j*137;rr(d,(38,yy,742,yy+118),outline=BORDER);txt(d,(65,yy+37),s,28);txt(d,(670,yy+37),'›',32,MUTED)
save('08-profile.png',im)

# 企業・運営の画面設計参照（Web、架空データ）
im=Image.new('RGB',(1440,900),'#f4f8fc');d=ImageDraw.Draw(im)
d.rectangle((0,0,280,900),fill=NAVY);txt(d,(34,34),'HappyDrive',40,'white')
for i,item in enumerate(['ダッシュボード','案件管理','応募・マッチング','実施・検収','請求・支払','メッセージ','組織・設定']):
 y=155+i*76
 if i==0:rr(d,(18,y-10,258,y+56),'#184b96',r=15)
 txt(d,(42,y),item,23,'white' if i==0 else '#b9c8e5')
txt(d,(328,46),'企業ダッシュボード',40);txt(d,(332,112),'本日の業務と応募状況を確認できます',22,MUTED)
for i,(head,value,col) in enumerate([('公開中の案件','18件',BLUE),('本日の稼働','12人',GREEN),('検収待ち','3件','#f1a527')]):
 x=324+i*366;rr(d,(x,170,x+336,330),outline=BORDER);txt(d,(x+30,196),head,23,MUTED);txt(d,(x+30,244),value,42,col)
rr(d,(324,370,1374,844),outline=BORDER);txt(d,(354,396),'案件の進行状況',30)
for i,(name,category,applies,state) in enumerate([('買い物付き添い','生活サポート','応募 4件','実施中'),('書類の回収','企業依頼','応募 2件','募集中'),('道路状況の撮影','地域調査','応募 1件','検収待ち'),('高齢者の見守り','生活サポート','応募 3件','募集中')]):
 y=474+i*89;d.line((354,y+74,1340,y+74),fill=BORDER,width=2);txt(d,(370,y+11),name,24);txt(d,(764,y+13),category,21,MUTED);txt(d,(985,y+13),applies,21,MUTED);pill(d,(1164,y+5,1333,y+55),state,GREEN if state=='実施中' else BLUE if state=='募集中' else '#e69a20','white',19)
save('09-partner-dashboard.png',im)
