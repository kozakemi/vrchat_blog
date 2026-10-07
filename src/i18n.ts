import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const STORAGE_KEY = "td_lang";

type AppLanguage = "zh" | "ja" | "en";

function normalizeToAppLanguage(language: string): AppLanguage {
  const lower = language.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("ja")) return "ja";
  return "en";
}

function getInitialLanguage(): AppLanguage {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "zh" || stored === "ja" || stored === "en") return stored;

  const preferred = window.navigator.languages?.[0] ?? window.navigator.language ?? "en";
  const initial = normalizeToAppLanguage(preferred);
  window.localStorage.setItem(STORAGE_KEY, initial);
  return initial;
}

export function persistLanguage(language: AppLanguage) {
  window.localStorage.setItem(STORAGE_KEY, language);
}

i18n.use(initReactI18next).init({
  resources: {
    zh: {
      translation: {
        login: "登录",
        keyLogin: "密钥登录",
        register: "注册",
        importKey: "导入密钥文件",
        keySelected: "已选择",
        nicknamePlaceholder: "给自己起个昵称…",
        enterAlbum: "进入相册",
        generateKey: "生成并下载密钥",
        loggedInAs: "当前身份：{{name}}",
        logout: "退出登录",
        close: "关闭",
        needKeyNotice: "请先导入密钥文件，再进入相册。",
        persistenceUnavailable:
          "当前浏览器禁用了本地存储（可能是隐私模式或「阻止所有 Cookie」），登录状态无法保留：刷新页面后需要重新导入密钥。",
        registerNotice: "密钥文件已保存为「{{file}}」。请把它收好——下次进来要用它。",
        errKeyFileRead: "这个文件读不出来，请重新选择。",
        errKeyFileNotJson: "这不是本站的密钥文件，请选择进入相册时下载的 key-*.json。",
        errKeyFileVersion: "密钥文件版本不受支持，请重新获取。",
        errKeyFileInvalid: "密钥文件内容不完整或已损坏，请重新获取。",
        errRegisterUnavailable: "本站暂未开放注册。",
        errRegisterConfig: "注册暂时不可用，请稍后再试。",
        loginHelpTitle: "使用说明",
        loginHelpBody:
          "第一次来：切到「注册」，填个昵称，会下载一个密钥文件——请把它保存在你找得到的地方，下次靠它进来。\n已经有密钥文件：切到「密钥登录」，选择那个文件即可。",
      },
    },
    ja: {
      translation: {
        login: "ログイン",
        keyLogin: "キーでログイン",
        register: "新規登録",
        importKey: "キーファイルを選択",
        keySelected: "選択済み",
        nicknamePlaceholder: "ニックネームを入力…",
        enterAlbum: "アルバムへ",
        generateKey: "キーを作成して保存",
        loggedInAs: "現在のユーザー：{{name}}",
        logout: "ログアウト",
        close: "閉じる",
        needKeyNotice: "先にキーファイルを選んでください。",
        persistenceUnavailable:
          "このブラウザではローカルストレージが無効です（プライベートモードや Cookie のブロックなど）。ログイン状態を保持できないため、再読み込みのたびにキーファイルを選び直す必要があります。",
        registerNotice: "キーファイルを「{{file}}」として保存しました。次回の入室に必要なので大切に保管してください。",
        errKeyFileRead: "ファイルを読み込めませんでした。選び直してください。",
        errKeyFileNotJson: "このサイトのキーファイルではありません。入室時にダウンロードした key-*.json を選んでください。",
        errKeyFileVersion: "このキーファイルのバージョンは未対応です。取得し直してください。",
        errKeyFileInvalid: "キーファイルの内容が不完全か壊れています。取得し直してください。",
        errRegisterUnavailable: "現在、新規登録は受け付けていません。",
        errRegisterConfig: "登録を利用できません。しばらくしてからお試しください。",
        loginHelpTitle: "使い方",
        loginHelpBody:
          "はじめての方：「新規登録」でニックネームを入力するとキーファイルがダウンロードされます。次回のために保管してください。\nすでにキーファイルをお持ちの方：「キーでログイン」でそのファイルを選んでください。",
      },
    },
    en: {
      translation: {
        login: "LOGIN",
        keyLogin: "KEY LOGIN",
        register: "REGISTER",
        importKey: "Import Key File",
        keySelected: "Selected",
        nicknamePlaceholder: "Choose a nickname…",
        enterAlbum: "Enter album",
        generateKey: "Create & download key",
        loggedInAs: "Signed in as {{name}}",
        logout: "Log out",
        close: "Close",
        needKeyNotice: "Please import your key file first, then enter the album.",
        persistenceUnavailable:
          "This browser has local storage disabled (private mode or blocked cookies), so your sign-in cannot be kept — you will need to import your key file again after a refresh.",
        registerNotice: "Your key file was saved as “{{file}}”. Keep it safe — you will need it next time.",
        errKeyFileRead: "That file could not be read. Please pick it again.",
        errKeyFileNotJson: "That is not a key file from this site. Please choose the key-*.json you downloaded.",
        errKeyFileVersion: "This key file version is not supported. Please get a new one.",
        errKeyFileInvalid: "This key file is incomplete or damaged. Please get a new one.",
        errRegisterUnavailable: "Registration is not open right now.",
        errRegisterConfig: "Registration is unavailable. Please try again later.",
        loginHelpTitle: "How to use",
        loginHelpBody:
          "First time here: switch to “Register”, type a nickname, and a key file will be downloaded — keep it somewhere you will find again.\nAlready have a key file: switch to “Key login” and choose that file.",
      },
    },
  },
  lng: getInitialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
