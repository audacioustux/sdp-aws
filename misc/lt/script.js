import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ui: {
      executor: "ramping-arrival-rate",
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [{ duration: "10m", target: 100 }],
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