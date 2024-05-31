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

export { git, pulumi, grafana }
