// 违禁词（用于内容审核）：明显脏话、歧视性用语与垃圾营销/诈骗词。
// 前后端各维护同一份（此文件为后端权威来源；前端 home.html 内联一份用于即时拦截）。
// 任意用户输入（主页内容、个人资料、通知等）写入前都必须经过本模块扫描。
export const FORBIDDEN = [
  // 英文脏话 / slurs（小写）
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'whore', 'slut',
  'nigger', 'faggot', 'retard', 'tranny', 'nazi', 'kill yourself', 'kys',
  // 中文脏话 / 歧视
  '傻逼', 'sb', '草泥马', '操你', '日你', '妈的', '贱人', '婊子', '杂种', '滚蛋',
  '废青', '支那', '洋奴', '汉奸', '狗杂种',
  // 垃圾营销 / 诈骗
  '加微信', '扫码领', '免费送', '刷单', '博彩', '赌博', '色情', '裸聊', '办证', '代开发票',
  '点击领取', '一元购', '日赚', '月入过万', '私聊客服'
];

// 逐个文本匹配，命中返回违禁词，未命中返回 null
export function matchForbidden(text) {
  if (!text) return null;
  const low = String(text).toLowerCase();
  for (const w of FORBIDDEN) {
    if (w && low.indexOf(String(w).toLowerCase()) !== -1) return w;
  }
  return null;
}

// 批量扫描一组文本，命中返回首个违禁词，否则 null
export function scanTexts(texts) {
  for (const t of texts) {
    const w = matchForbidden(t);
    if (w) return w;
  }
  return null;
}
