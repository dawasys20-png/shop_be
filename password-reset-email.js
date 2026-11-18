const nodemailer = require("nodemailer");

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function getEmailConfiguration() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim();
  const appUrl = process.env.APP_URL?.trim();
  const port = Number(process.env.SMTP_PORT || 587);

  if (!host || !user || !password || !from || !appUrl) {
    throw new Error(
      "Password reset email requires SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, and APP_URL.",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid port number.");
  }

  let baseUrl;
  try {
    baseUrl = new URL(appUrl);
  } catch {
    throw new Error("APP_URL must be a valid website URL.");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("APP_URL must use HTTP or HTTPS.");
  }

  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: { user, pass: password },
    from,
    resetBaseUrl: new URL("/reset-password", baseUrl).toString(),
  };
}

async function sendPasswordResetEmail({ email, name, token }) {
  const config = getEmailConfiguration();
  const resetUrl = new URL(config.resetBaseUrl);
  resetUrl.searchParams.set("token", token);
  const greeting = name ? `Hello ${name},` : "Hello,";
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: "Reset your VitaHub password",
    text: `${greeting}\n\nWe received a request to reset the password for your VitaHub account. Use this link within one hour:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>${escapeHtml(greeting)}</p><p>We received a request to reset the password for your VitaHub account. Use this link within one hour:</p><p><a href="${escapeHtml(resetUrl.toString())}">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`,
  });
}

module.exports = { sendPasswordResetEmail };
