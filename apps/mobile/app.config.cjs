const base = require("./app.json").expo;

module.exports = () => {
  const redirect = process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL;
  const config = structuredClone(base);
  config.android.allowBackup = false;
  if (redirect) {
    const url = new URL(redirect);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/auth/callback" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error(
        "EXPO_PUBLIC_AUTH_REDIRECT_URL must be https://<verified-domain>/auth/callback",
      );
    config.ios.associatedDomains = [`applinks:${url.hostname}`];
    config.android.intentFilters = [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: url.hostname, pathPrefix: "/auth/callback" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ];
  }
  return config;
};
