import { useTranslation } from "react-i18next";
import { getLanguageLabel, getNextLanguage, persistLanguage } from "@/i18n";

/**
 * 语言切换按钮（登录页与关于页共用）。
 *
 * 只统一「点一下就循环切到下一个语言 + 记住选择」这个行为，样式由调用方给：
 * 登录页用 index.css 里绝对定位的 `.lang-switch`，关于页用 Tailwind。
 * 切换顺序与语言名的写法都放在 i18n.ts，避免两个页面各写一份而走样。
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t, i18n: i18nInstance } = useTranslation();

  return (
    <button
      type="button"
      className={className}
      aria-label={t("languageSwitch")}
      onClick={() => {
        const next = getNextLanguage(i18nInstance.language);
        void i18nInstance.changeLanguage(next);
        persistLanguage(next);
      }}
    >
      {getLanguageLabel(i18nInstance.language)}
    </button>
  );
}

export default LanguageSwitch;
