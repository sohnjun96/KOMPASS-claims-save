import { ANALYST_MODEL } from "./model_config.js";

const DEFAULT_WEBUI_BASE_URL = "https://llm.moip.go.kr";
const CHAT_COMPLETIONS_PATH = "/api/chat/completions";

async function resolveServerUrl() {
  const data = await chrome.storage.local.get("webuiBaseUrl");
  const baseUrl = String(data.webuiBaseUrl || DEFAULT_WEBUI_BASE_URL)
    .trim()
    .replace(/\/+$/, "");

  return `${baseUrl}${CHAT_COMPLETIONS_PATH}`;
}

export async function callOpenWebUI(messages, modelName = ANALYST_MODEL, temperature = 0.7) {
  const data = await chrome.storage.local.get("ksuiteSharedApiKey");
  const apiKey = String(data.ksuiteSharedApiKey || "").trim();

  if (!apiKey) throw new Error("API key is not set.");

  const response = await fetch(await resolveServerUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: messages,
      temperature: temperature
    })
  });

  if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
  const result = await response.json();
  return result.choices[0].message.content;
}
