import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Code2, Github, Video } from "lucide-react";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useSessionAuthStore } from "@/store/sessionAuthStore";

/**
 * 关于页（公开页面，不需要密钥即可访问）。
 *
 * 这里刻意不放任何与密钥、相册内容有关的东西：它是一张"谁做的、去哪找我"的说明页，
 * 分享出去给没进过相册的人看也不会泄露任何私有信息。
 */

const AUTHOR_NAME = "Kozakemi";
const GITHUB_URL = "https://github.com/kozakemi";
const BILIBILI_URL = "https://space.bilibili.com/695983037";
const REPO_URL = "https://github.com/kozakemi/vrchat_blog";

/** public/ 下的静态资源在 HashRouter 里要用 BASE_URL 拼，不能写死根路径 */
function publicAsset(name: string): string {
  const base = import.meta.env.BASE_URL || "./";
  return `${base.endsWith("/") ? base : `${base}/`}${name}`;
}

const LINK_BUTTON_CLASS =
  "inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/5 px-3 py-2 text-xs font-extrabold text-white/85 hover:bg-white/10";

export default function About() {
  const { t } = useTranslation();
  const keySession = useSessionAuthStore((s) => s.keySession);

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-black to-zinc-950 text-white">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-10">
        <header className="flex items-center justify-between gap-3">
          <Link to="/" className={LINK_BUTTON_CLASS}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("aboutBack")}
          </Link>
          <LanguageSwitch className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold tracking-wide text-white/75 hover:bg-white/10" />
        </header>

        <h1 className="text-xl font-extrabold tracking-wide">{t("aboutTitle")}</h1>

        <section className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-5 text-center">
          <img
            src={publicAsset("avatar.jpg")}
            alt={AUTHOR_NAME}
            width={96}
            height={96}
            className="h-24 w-24 rounded-full border border-white/15 object-cover"
          />
          <div>
            <div className="text-sm font-extrabold">{AUTHOR_NAME}</div>
            <div className="mt-0.5 text-[11px] text-white/50">{t("aboutAuthorLabel")}</div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" className={LINK_BUTTON_CLASS}>
              <Github className="h-4 w-4" aria-hidden="true" />
              {t("aboutLinkGithub")}
            </a>
            <a href={BILIBILI_URL} target="_blank" rel="noreferrer noopener" className={LINK_BUTTON_CLASS}>
              <Video className="h-4 w-4" aria-hidden="true" />
              {t("aboutLinkBilibili")}
            </a>
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={LINK_BUTTON_CLASS}>
              <Code2 className="h-4 w-4" aria-hidden="true" />
              {t("aboutLinkRepo")}
            </a>
          </div>
        </section>

        <section className="rounded-2xl border border-amber-400/25 bg-amber-950/20 p-4">
          <div className="text-xs font-extrabold text-amber-100">{t("aboutAiTitle")}</div>
          <p className="mt-2 text-[12px] leading-relaxed text-white/75">{t("aboutAiBody")}</p>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs font-extrabold text-white/80">{t("aboutDisclaimerTitle")}</div>
          <p className="mt-2 text-[12px] leading-relaxed text-white/60">
            {t("aboutDisclaimerBody")}
          </p>
        </section>

        {keySession ? (
          <Link
            to="/album"
            className="self-center rounded-xl border border-amber-400/50 bg-amber-500/25 px-5 py-2.5 text-xs font-extrabold text-amber-50 hover:bg-amber-500/35"
          >
            {t("aboutEnterAlbum")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
