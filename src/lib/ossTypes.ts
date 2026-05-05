/** 管理页「加密并上传 OSS」使用的凭据（仅驻留浏览器内存 / sessionStorage，勿提交到 Git） */
export type OssUploadConfig = {
  oss_access_key_id: string;
  oss_access_key_secret: string;
  /** 如 oss-cn-beijing.aliyuncs.com */
  oss_endpoint: string;
  oss_bucket_name: string;
};
