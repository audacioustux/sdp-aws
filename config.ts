import { getProject, getOrganization, getStack, Config } from '@pulumi/pulumi'

const pulumi = {
  organization: getOrganization().toLowerCase(),
  project: getProject().toLowerCase(),
  stack: getStack().toLowerCase(),
}

const gitConfig = new Config('git')
const git = {
  repo: gitConfig.require('repo'),
  path: gitConfig.require('path'),
  username: gitConfig.require('username'),
  password: gitConfig.requireSecret('password'),
}

const grafanaConfig = new Config('grafana')
const grafana = {
  password: grafanaConfig.requireSecret('password'),
  host: grafanaConfig.requireSecret('host'),
}

const defaults = {
  pod: {
    resources: {
      requests: {
        cpu: '50m',
        memory: '64Mi',
      },
      limits: {
        memory: '128Mi',
      },
    },
  },
}

// TODO: move all hardcoded versions to this file

export { git, pulumi, grafana, defaults }
