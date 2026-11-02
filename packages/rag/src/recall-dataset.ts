/**
 * V2.8 recall eval (stages/V2.8.md §4.1). Each answerable question names the article and a short
 * passage of its text, not a chunk id, so both chunking strategies are scored on the same set.
 * Unanswerable questions are near the corpus's topics but not in it; they set the threshold.
 * Questions include phrasings the V2.7 question check (`ASKS`) misses (§3.7).
 */
// v2: second batch of articles (20 in all); the v1 unanswerable topics are now in the corpus,
// so they became answerable and new unanswerable ones replace them; 10 + 2 held out.
export const RECALL_DATASET_VERSION = "v28-recall.v2";

export interface RecallCase {
  readonly id: string;
  readonly question: string;
  /** null: nothing in the corpus answers it. */
  readonly expect: { readonly document: string; readonly snippet: string } | null;
  /** Not used to pick the threshold; scored with the threshold picked on the others. */
  readonly heldOut?: boolean;
}

export const RECALL_CASES: readonly RecallCase[] = [
  { id: "R01", question: "西湖十景是怎么来的", expect: { document: "west-lake-ten-views", snippet: "画家称湖山四时景色最奇者有十" } },
  { id: "R02", question: "西湖十景最早记载在哪本书里", expect: { document: "west-lake-ten-views", snippet: "祝穆的《方舆胜览》" } },
  { id: "R03", question: "曲院风荷原来叫什么名字", expect: { document: "west-lake-ten-views", snippet: "“麹院荷风”改为“曲院风荷”" } },
  { id: "R04", question: "新西湖十景是哪一年评出来的", expect: { document: "west-lake-ten-views", snippet: "发起“新西湖十景”评选" } },
  { id: "R05", question: "苏堤是谁修的", expect: { document: "su-bai-causeways", snippet: "苏轼第二次到杭州做官" } },
  { id: "R06", question: "白堤是白居易修的吗", expect: { document: "su-bai-causeways", snippet: "并不是白居易当年修的那一道" } },
  { id: "R07", question: "苏堤上的六座桥分别叫什么", expect: { document: "su-bai-causeways", snippet: "映波、锁澜、望山、压堤、东浦、跨虹" } },
  { id: "R08", question: "介绍一下灵隐寺", expect: { document: "lingyin-temple", snippet: "由西印度僧人慧理开山" } },
  { id: "R09", question: "飞来峰这个名字的由来", expect: { document: "lingyin-temple", snippet: "像天竺灵鹫山的一座小峰" } },
  { id: "R10", question: "灵隐寺为什么又叫云林禅寺", expect: { document: "lingyin-temple", snippet: "题写“云林禅寺”匾额" } },
  { id: "R11", question: "越剧是哪里的剧种", expect: { document: "yue-opera", snippet: "越剧起源于浙江嵊县" } },
  { id: "R12", question: "越剧十姐妹是哪几位", expect: { document: "yue-opera", snippet: "袁雪芬、尹桂芳、筱丹桂" } },
  { id: "R13", question: "越剧有哪些代表剧目", expect: { document: "yue-opera", snippet: "《梁山伯与祝英台》《红楼梦》" } },
  { id: "R14", question: "讲讲龙井茶的历史", expect: { document: "longjing-tea", snippet: "“狮、龙、云、虎、梅”五个字号" } },
  { id: "R15", question: "龙井43和群体种有什么区别", expect: { document: "longjing-tea", snippet: "从群体种中选育的无性系良种" } },
  { id: "R16", question: "杭帮菜有什么特点", expect: { document: "hangzhou-cuisine", snippet: "“清、香、爽、嫩”" } },
  { id: "R17", question: "做西湖醋鱼为什么要先把鱼饿几天", expect: { document: "hangzhou-cuisine", snippet: "饿养几天去土腥味" } },
  { id: "R18", question: "拱宸桥是什么时候建的", expect: { document: "grand-canal-hangzhou", snippet: "明崇祯四年（1631 年）" } },
  { id: "R19", question: "富义仓以前是做什么用的", expect: { document: "grand-canal-hangzhou", snippet: "杭州现存唯一的古粮仓" } },
  { id: "R20", question: "南宋的皇宫在杭州哪里", expect: { document: "southern-song-lin-an", snippet: "皇城在城南的凤凰山一带" } },
  { id: "R21", question: "德寿宫原来是谁住的地方", expect: { document: "southern-song-lin-an", snippet: "宋高宗退位后的居所" } },
  { id: "R22", question: "浙江省博物馆是怎么建起来的", expect: { document: "zhejiang-museum", snippet: "起因是当年举办的首届西湖博览会" } },
  { id: "R23", question: "剩山图和富春山居图是什么关系", expect: { document: "zhejiang-museum", snippet: "前段较短的一段称《剩山图》" } },
  { id: "R24", question: "中国茶叶博物馆分成几个馆区", expect: { document: "china-tea-museum", snippet: "双峰馆区和龙井馆区两部分" } },
  { id: "R25", question: "雷峰塔是谁建的", expect: { document: "leifeng-pagoda", snippet: "由吴越国王钱俶（钱弘俶）主持修建" } },
  { id: "R26", question: "雷峰塔为什么会倒掉", expect: { document: "leifeng-pagoda", snippet: "从塔基挖取塔砖" } },
  { id: "R27", question: "岳飞墓前跪着的是谁", expect: { document: "yue-fei-temple", snippet: "秦桧、王氏、万俟卨、张俊" } },
  { id: "R28", question: "西泠印社是什么时候成立的", expect: { document: "xiling-seal-society", snippet: "创建于清光绪三十年（1904 年）" } },
  { id: "R29", question: "六和塔这个名字是什么意思", expect: { document: "liuhe-pagoda", snippet: "取佛教“六和敬”之义" } },
  { id: "R30", question: "良渚古城是什么时候发现的", expect: { document: "liangzhu", snippet: "2007 年，良渚古城被发现和确认" } },
  { id: "R31", question: "胡庆余堂是谁开的", expect: { document: "huqingyu-tang", snippet: "胡雪岩创办的中药号" }, heldOut: true },
  { id: "R32", question: "清河坊这个名字怎么来的", expect: { document: "hefang-street", snippet: "张俊晚年被封为清河郡王" }, heldOut: true },
  { id: "R33", question: "杭州丝绸有什么历史", expect: { document: "hangzhou-silk", snippet: "明清时期杭绸、杭缎远近闻名" }, heldOut: true },
  { id: "R34", question: "钱塘江大潮是怎么形成的", expect: { document: "qiantang-tide", snippet: "杭州湾呈喇叭形" }, heldOut: true },
  { id: "R35", question: "西溪湿地是哪年变成公园的", expect: { document: "xixi-wetland", snippet: "2005 年 5 月西溪国家湿地公园开园" }, heldOut: true },
  { id: "R36", question: "白娘子被压在哪座塔下", expect: { document: "leifeng-pagoda", snippet: "法海把白娘子镇在雷峰塔下" }, heldOut: true },
  { id: "R37", question: "六和塔为什么爬到七层就到顶了", expect: { document: "liuhe-pagoda", snippet: "称为“七明六暗”" }, heldOut: true },
  { id: "R38", question: "良渚的水利工程有多早", expect: { document: "liangzhu", snippet: "目前已知中国最早的大型水利系统" }, heldOut: true },
  { id: "R39", question: "胡庆余堂的戒欺匾为什么朝里挂", expect: { document: "huqingyu-tang", snippet: "唯独这块“戒欺”匾朝里挂" }, heldOut: true },
  { id: "R40", question: "去哪里看钱塘江大潮最好", expect: { document: "qiantang-tide", snippet: "海宁盐官一段江道顺直" }, heldOut: true },
  { id: "U01", question: "保俶塔是谁建的", expect: null },
  { id: "U02", question: "千岛湖是怎么形成的", expect: null },
  { id: "U03", question: "径山寺有什么历史", expect: null },
  { id: "U04", question: "张小泉剪刀有什么来历", expect: null },
  { id: "U05", question: "南宋官窑烧的是什么瓷器", expect: null },
  { id: "U06", question: "葱包桧这个名字怎么来的", expect: null },
  { id: "U07", question: "于谦是哪里人", expect: null },
  { id: "U08", question: "宋城是什么时候建的", expect: null },
  { id: "U09", question: "王星记扇子有什么特点", expect: null, heldOut: true },
  { id: "U10", question: "钱王祠纪念的是谁", expect: null, heldOut: true },
];
