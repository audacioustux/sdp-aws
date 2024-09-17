import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ui: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [{ duration: "5m", target: 100 }],
      gracefulRampDown: "0s",
    },
  },
  thresholds: {
    http_req_waiting: [{ threshold: "p(95)<10000", abortOnFail: true, delayAbortEval: "1m" }],
    http_req_failed: [{ threshold: "rate<0.1", abortOnFail: true, delayAbortEval: "1m" }]
  },
};

export default async function main() {
  http.get("https://coderstrust.us/mautic-lt");
}