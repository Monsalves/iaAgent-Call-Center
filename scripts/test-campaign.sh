#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://iaagent-monsalves.northcentralus.cloudapp.azure.com}"
CSV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/medical-appointment-demo.csv"
CAMPAIGN_NAME="Medical appointment reminder demo"
CAMPAIGN_PROMPT="Speak only in English for the entire call. Make a very short medical appointment reminder call. Greet the contact, state the appointment date, time, doctor and clinic from the contact context, then ask whether they can attend. If they confirm or decline, acknowledge the answer and end the call politely. Do not invent information."
TOKEN="${TWILIO_CALL_TRIGGER_TOKEN:-}"

if [[ -z "${TOKEN}" ]]; then
  read -r -s -p "TWILIO_CALL_TRIGGER_TOKEN: " TOKEN
  echo
fi
if [[ -z "${TOKEN}" ]]; then
  echo "Error: el token no puede estar vacio." >&2
  exit 1
fi

auth=(-H "Authorization: Bearer ${TOKEN}")
payload=$(node -e '
  const [name, prompt] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ name, prompt }));
' "${CAMPAIGN_NAME}" "${CAMPAIGN_PROMPT}")

created=$(curl --fail-with-body --silent --show-error \
  -X POST "${BASE_URL}/api/campaigns" "${auth[@]}" \
  -H "Content-Type: application/json" --data "${payload}")
campaign_id=$(node -e '
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => process.stdout.write(JSON.parse(input).campaign.id));
' <<<"${created}")

curl --fail-with-body --silent --show-error \
  -X POST "${BASE_URL}/api/campaigns/${campaign_id}/contacts/csv" "${auth[@]}" \
  -H "Content-Type: text/csv" --data-binary "@${CSV_FILE}"
echo
curl --fail-with-body --silent --show-error \
  -X POST "${BASE_URL}/api/campaigns/${campaign_id}/start" "${auth[@]}"
echo
echo "Campana iniciada: ${campaign_id}"
