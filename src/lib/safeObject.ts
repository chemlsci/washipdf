/**
 * 文書や保存データから来た文字列で、普通のオブジェクトを引くときの補助。
 * obj[key] や key in obj は、"constructor"・"toString"・"__proto__" のような名前で、どのオブジェクトにもある関数などに当たる。
 * 自分で持っている項目かどうかを先に確かめる（Object.hasOwn は少し古い Safari に無いので、昔からある書き方を使う）
 */
export const hasOwn = (obj: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(obj, key);
