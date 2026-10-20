// 企业微信“加解密方案”的官方示例向量：Token、EncodingAESKey、企业 ID 取自官方文档，
// 签名和密文取自官方 SDK（weworkapi_golang 的 sample.go）；这组数据算得出官方给的签名、解得出官方给的明文。
export const OFFICIAL = { token: "QDG6eK", aesKey: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C", receiveId: "wx5823bf96d3bd56c7" };

export const OFFICIAL_VERIFY_URL = {
  signature: "5c45ff5e21c57e6ad56bac8758b79b1d9ac89fd3",
  timestamp: "1409659589",
  nonce: "263014780",
  echostr: "P9nAzCzyDtyTWESHep1vC5X9xho/qYX3Zpb4yKa9SKld1DsH3Iyt3tP3zNdtp+4RPcs8TgAE7OaBO+FZXvnaqQ==",
  plain: "1616140317555161061",
};

export const OFFICIAL_POST = {
  signature: "477715d11cdb4164915debcba66cb864d751f3e6",
  timestamp: "1409659813",
  nonce: "1372623149",
  encrypt:
    "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==",
};
