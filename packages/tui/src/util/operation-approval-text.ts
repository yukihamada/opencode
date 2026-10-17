const messages = {
  ja: {
    notice: "この引数で今回のみ実行します。既知の秘密欄は伏字ですが、本文・コード内の秘密は検出できない場合があります。クリック先の実際の送信内容は別途確認してください。",
    once: "今回のみ承認",
    reject: "実行しない",
    allowOnce: "今回のみ許可",
    always: "常に許可",
  },
  en: {
    notice: "Run once with these arguments. Known credential fields are redacted; secrets in text or code may remain visible. Verify the actual effect of browser clicks separately.",
    once: "Approve this request",
    reject: "Do not execute",
    allowOnce: "Allow once",
    always: "Allow always",
  },
}

export function operationApprovalText(locale: string) {
  return messages[locale.startsWith("ja") ? "ja" : "en"]
}
