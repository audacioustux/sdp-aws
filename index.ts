import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import { registerAutoTags } from './utils/autoTag.ts'
import * as config from './config.ts'
import { assumeRoleForEKSPodIdentity } from './utils/policyStatement.ts'
import * as random from '@pulumi/random'

const partitionId = await aws.getPartition().then((partition) => partition.id)
const regionId = await aws.getRegion().then((region) => region.id)
const accountId = await aws.getCallerIdentity().then((identity) => identity.accountId)

const { project, stack } = config.pulumi

// Automatically inject tags.
registerAutoTags(config.defaults.tagsAll)

const nm = (name: string) => `${project}-${stack}-${name}`

// === VPC ===

const vpcName = nm('vpc')
const vpc = new aws.ec2.Vpc(vpcName, {
  cidrBlock: '10.0.0.0/16',
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: {
    Name: vpcName,
  },
})

// === VPC === Subnets ===

const availabilityZones = await aws
  .getAvailabilityZones({
    state: 'available',
  })
  .then(({ names }) => names.slice(0, 3))
// NOTE: 10.0.48.0/20 is free for future use
const publicSubnets = availabilityZones.map((az, index) => {
  const subnetName = nm(`public-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index * 16}.0/20`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: subnetName,
      'kubernetes.io/role/elb': '1',
    },
  })
})
const privateSubnets = availabilityZones.map((az, index) => {
  const subnetName = nm(`private-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index * 64 + 64}.0/18`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags: {
      Name: subnetName,
      'kubernetes.io/role/internal-elb': '1',
    },
  })
})

// === VPC === Internet Gateway ===

const internetGatewayName = nm('igw')
const internetGateway = new aws.ec2.InternetGateway(internetGatewayName, {
  vpcId: vpc.id,
  tags: {
    Name: internetGatewayName,
  },
})

// === VPC === NAT Gateway ===

const eipName = nm('eip')
const eip = new aws.ec2.Eip(eipName, {
  domain: 'vpc',
  tags: {
    Name: eipName,
  },
})

const natGatewayName = nm('nat')
const natGateway = new aws.ec2.NatGateway(natGatewayName, {
  subnetId: publicSubnets[0].id,
  allocationId: eip.id,
  connectivityType: 'public',
  tags: {
    Name: natGatewayName,
  },
})

// === VPC === Route Tables ===

const publicRouteTableName = nm('public')
const publicRouteTable = new aws.ec2.RouteTable(publicRouteTableName, {
  vpcId: vpc.id,
  tags: {
    Name: publicRouteTableName,
  },
})
new aws.ec2.Route(nm('to-igw'), {
  routeTableId: publicRouteTable.id,
  destinationCidrBlock: '0.0.0.0/0',
  gatewayId: internetGateway.id,
})
publicSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(
    `public-assoc-${index}`,
    {
      routeTableId: publicRouteTable.id,
      subnetId: subnet.id,
    },
    { parent: publicRouteTable },
  )
})

const privateRouteTableName = nm('private')
const privateRouteTable = new aws.ec2.RouteTable(privateRouteTableName, {
  vpcId: vpc.id,
  tags: {
    Name: privateRouteTableName,
  },
})
new aws.ec2.Route(nm('to-nat'), {
  routeTableId: privateRouteTable.id,
  destinationCidrBlock: '0.0.0.0/0',
  natGatewayId: natGateway.id,
})
privateSubnets.map((subnet, index) => {
  return new aws.ec2.RouteTableAssociation(
    `private-assoc-${index}`,
    {
      routeTableId: privateRouteTable.id,
      subnetId: subnet.id,
    },
    { parent: privateRouteTable },
  )
})

// === VPC === S3 Access Endpoint ===

const s3EndpointName = nm('s3-endpoint')
new aws.ec2.VpcEndpoint(s3EndpointName, {
  vpcId: vpc.id,
  serviceName: `com.amazonaws.${regionId}.s3`,
  routeTableIds: [publicRouteTable.id, privateRouteTable.id],
  vpcEndpointType: 'Gateway',
})

// === KMS ===

const kmsKeyName = nm('kms')
const kmsKey = new aws.kms.Key(kmsKeyName, {
  bypassPolicyLockoutSafetyCheck: false,
  enableKeyRotation: true,
  deletionWindowInDays: 30,
})
new aws.kms.Alias(kmsKeyName, {
  name: `alias/${kmsKeyName}`,
  targetKeyId: kmsKey.id,
})

// === EKS === Cluster ===

const ecrPullThroughPolicy = new aws.iam.Policy(nm('ecr-pull-through-policy'), {
  policy: pulumi.output({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ecr:CreateRepository', 'ecr:ReplicateImage', 'ecr:BatchImportUpstreamImage'],
        Resource: '*',
      },
    ],
  }),
})

const eksInstanceRole = new aws.iam.Role(nm('eks-instance-role'), {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
    'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
    'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    ecrPullThroughPolicy.arn,
  ],
})

// TODO: aad warmpool
// NOTE: https://github.com/aws/karpenter-provider-aws/issues/4354

const eksClusterName = nm('eks')
const {
  eksCluster,
  core: cluster,
  kubeconfig,
  provider,
} = new eks.Cluster(eksClusterName, {
  name: eksClusterName,
  version: '1.31',
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  privateSubnetIds: privateSubnets.map((s) => s.id),
  nodeAssociatePublicIpAddress: false,
  encryptionConfigKeyArn: kmsKey.arn,
  defaultAddonsToRemove: ['kube-proxy', 'vpc-cni', 'coredns'],
  useDefaultVpcCni: true,
  // TODO: disable public access to the cluster (use vpc client endpoint instead)
  // endpointPublicAccess: false,
  skipDefaultNodeGroup: true,
  instanceRole: eksInstanceRole,
  clusterTags: config.defaults.tagsAll,
})

// === EKS === Node Group ===

const nodeGroupConfig = {
  nodeRole: cluster.instanceRoles[0],
  subnetIds: privateSubnets.map((s) => s.id),
  // TODO: switch to Bottlerocket
  // NOTE: https://github.com/pulumi/pulumi-eks/issues/1179
  // NOTE: https://github.com/bottlerocket-os/bottlerocket/issues/1721
  // NOTE: https://github.com/cilium/cilium/issues/32616#issuecomment-2126367506
  // amiType: 'BOTTLEROCKET_ARM_64',
  // operatingSystem: eks.OperatingSystem.AL2023,
  // kubeletExtraArgs: '--max-pods=150 --max-pods-per-core=40',
  // bootstrapExtraArgs: '--use-max-pods false',
  amiType: 'AL2023_ARM_64_STANDARD',
}

const clusterOIDCProvider = cluster.oidcProvider!.apply((oidcProvider) => {
  if (!oidcProvider) throw new Error('OIDC provider is undefined')
  return oidcProvider
})

const spotNodeGroupName = nm('spot-node-group')
new eks.ManagedNodeGroup(spotNodeGroupName, {
  cluster,
  ...nodeGroupConfig,
  nodeGroupName: spotNodeGroupName,
  capacityType: 'SPOT',
  // NOTE: t4g instances has larger Pod limit than non-burstable instances
  instanceTypes: ['t4g.large'],
  scalingConfig: {
    minSize: 2,
    maxSize: 2,
    desiredSize: 2,
  },
  // labels: {
  //   'node.sdp.aws/capacity-type': 'spot',
  //   'node.sdp.aws/capacity-partition': 'spot-1',
  // },
  taints: [
    {
      key: 'node.cilium.io/agent-not-ready',
      value: 'true',
      effect: 'NO_EXECUTE',
    },
  ],
})

// const onDemandNodeGroupName = nm('on-demand-node-group')
// const onDemandNodeGroup = new eks.ManagedNodeGroup(onDemandNodeGroupName, {
//   cluster,
//   ...nodeGroupConfig,
//   nodeGroupName: onDemandNodeGroupName,
//   capacityType: 'ON_DEMAND',
//   // instanceTypes: ['t4g.large', 'm7g.large', 'm7gd.large', 'm6g.large', 'm6gd.large'],
//   instanceTypes: ['t4g.large'],
//   scalingConfig: {
//     minSize: 1,
//     maxSize: 1,
//     desiredSize: 1,
//   },
//   labels: {
//     'node.sdp.aws/capacity-type': 'on-demand',
//     'node.sdp.aws/capacity-partition': 'on-demand-1',
//   },
//   taints: [
//     {
//       key: 'node.cilium.io/agent-not-ready',
//       value: 'true',
//       effect: 'NO_EXECUTE',
//     },
//     {
//       key: 'node.sdp.aws/reserved',
//       value: 'dedicated',
//       effect: 'PREFER_NO_SCHEDULE',
//     },
//   ],
// })

// === EKS === Limit Range === Kube System ===

// TODO: reduce default, set explicit resource requests & limits
new k8s.core.v1.LimitRange(
  nm('kube-system-limit-range'),
  {
    metadata: {
      name: 'kube-system-limits',
      namespace: 'kube-system',
    },
    spec: {
      limits: [
        {
          defaultRequest: config.defaults.pod.resources.requests,
          type: 'Container',
        },
      ],
    },
  },
  { provider },
)

// === EKS === Gateway API ===

const gatewayAPI = new k8s.yaml.ConfigFile(
  nm('gateway-api'),
  {
    file: 'https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml',
  },
  { provider },
)

// === EKS === Cilium ===

// TODO: enable envoy slow start
// NOTO: https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/slow_start
const cilium = new k8s.helm.v3.Release(
  nm('cilium'),
  {
    name: 'cilium',
    chart: 'cilium',
    namespace: 'kube-system',
    version: '1.17.1',
    repositoryOpts: {
      repo: 'https://helm.cilium.io',
    },
    maxHistory: 1,
    values: {
      rollOutCiliumPods: true,
      kubeProxyReplacement: 'true',
      k8sClientRateLimit: {
        burst: 200,
        qps: 100,
      },
      k8sServiceHost: cluster.endpoint.apply((endpoint) => endpoint.replace('https://', '')),
      k8sServicePort: 443,
      ingressController: {
        enabled: true,
        loadbalancerMode: 'shared',
        default: true,
        enableProxyProtocol: true,
        service: {
          loadBalancerClass: 'service.k8s.aws/nlb',
          annotations: {
            'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
            'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
            'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'instance',
            'service.beta.kubernetes.io/aws-load-balancer-target-group-attributes': Object.entries({
              'preserve_client_ip.enabled': 'true',
              'proxy_protocol_v2.enabled': 'true',
              'deregistration_delay.timeout_seconds': '15',
            })
              .map(([k, v]) => `${k}=${v}`)
              .join(','),
            'service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags': Object.entries(
              config.defaults.tagsAll,
            )
              .map(([k, v]) => `${k}=${v}`)
              .join(','),
          },
        },
      },
      gatewayAPI: {
        enabled: true,
        enableProxyProtocol: true,
      },
      operator: {
        rollOutPods: true,
        prometheus: {
          enabled: true,
        },
      },
      loadBalancer: {
        algorithm: 'maglev',
        mode: 'hybrid',
      },
      envoy: {
        rollOutPods: true,
      },
      routingMode: 'native',
      ipam: {
        mode: 'eni',
      },
      eni: {
        enabled: true,
        awsEnablePrefixDelegation: true,
      },
      prometheus: {
        enabled: true,
      },
    },
  },
  { provider, dependsOn: [gatewayAPI] },
)

// === EKS === CoreDNS ===

new aws.eks.Addon(nm('coredns'), {
  addonName: 'coredns',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply((version) =>
    aws.eks.getAddonVersion({
      addonName: 'coredns',
      kubernetesVersion: version,
      mostRecent: true,
    }),
  ).version,
  configurationValues: JSON.stringify({
    autoScaling: {
      enabled: true,
    },
  }),
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// === EKS === Addons === Pod Identity Agent ===

new aws.eks.Addon(nm('pod-identity-agent'), {
  addonName: 'eks-pod-identity-agent',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'eks-pod-identity-agent',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// === EKS === Addons === EBS CSI Driver ===

// TODO: move all IRSA to Pod Identity Association

const ebsCsiDriverRoleName = nm('ebs-csi-driver-irsa')
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: pulumi.all([clusterOIDCProvider.url, clusterOIDCProvider.arn]).apply(([url, arn]) =>
    aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRoleWithWebIdentity'],
          principals: [
            {
              type: 'Federated',
              identifiers: [arn],
            },
          ],
          conditions: [
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:sub`,
              values: ['system:serviceaccount:kube-system:ebs-csi-controller-sa'],
            },
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:aud`,
              values: ['sts.amazonaws.com'],
            },
          ],
        },
      ],
    }),
  ).json,
})
new aws.iam.RolePolicyAttachment(`${ebsCsiDriverRoleName}-attachment`, {
  role: ebsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy',
})
new aws.eks.Addon(nm('ebs-csi-driver'), {
  addonName: 'aws-ebs-csi-driver',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'aws-ebs-csi-driver',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  serviceAccountRoleArn: ebsCsiDriverRole.arn,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// gp3 storage class, set as default
const gp3StorageClassName = 'gp3'
new k8s.storage.v1.StorageClass(
  nm(gp3StorageClassName),
  {
    metadata: {
      name: gp3StorageClassName,
      annotations: {
        'storageclass.kubernetes.io/is-default-class': 'true',
      },
    },
    provisioner: 'ebs.csi.aws.com',
    volumeBindingMode: 'WaitForFirstConsumer',
    reclaimPolicy: 'Delete',
    parameters: {
      type: 'gp3',
    },
    allowVolumeExpansion: true,
  },
  { provider },
)

// === EKS === Addons === EFS CSI Driver ===

const efsCsiDriverRoleName = nm('efs-csi-driver-irsa')
const efsCsiDriverRole = new aws.iam.Role(efsCsiDriverRoleName, {
  assumeRolePolicy: pulumi.all([clusterOIDCProvider.url, clusterOIDCProvider.arn]).apply(([url, arn]) =>
    aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRoleWithWebIdentity'],
          principals: [
            {
              type: 'Federated',
              identifiers: [arn],
            },
          ],
          conditions: [
            {
              test: 'StringLike',
              variable: `${url.replace('https://', '')}:sub`,
              values: ['system:serviceaccount:kube-system:efs-csi-*'],
            },
            {
              test: 'StringEquals',
              variable: `${url.replace('https://', '')}:aud`,
              values: ['sts.amazonaws.com'],
            },
          ],
        },
      ],
    }),
  ).json,
})
new aws.iam.RolePolicyAttachment(`${efsCsiDriverRoleName}-attachment`, {
  role: efsCsiDriverRole,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy',
})
new aws.eks.Addon(nm('efs-csi-driver'), {
  addonName: 'aws-efs-csi-driver',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'aws-efs-csi-driver',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  serviceAccountRoleArn: efsCsiDriverRole.arn,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// // === EKS === Addons === S3 Mountpoint Driver ===

// const s3MountpointDriverRoleName = nm('s3-mountpoint-driver-irsa')
// const s3MountpointDriverRole = new aws.iam.Role(s3MountpointDriverRoleName, {
//   assumeRolePolicy: pulumi.all([clusterOIDCProvider.url, clusterOIDCProvider.arn]).apply(([url, arn]) =>
//     aws.iam.getPolicyDocumentOutput({
//       statements: [
//         {
//           effect: 'Allow',
//           actions: ['sts:AssumeRoleWithWebIdentity'],
//           principals: [
//             {
//               type: 'Federated',
//               identifiers: [arn],
//             },
//           ],
//           conditions: [
//             {
//               test: 'StringEquals',
//               variable: `${url.replace('https://', '')}:sub`,
//               values: ['system:serviceaccount:kube-system:s3-csi-driver-sa'],
//             },
//             {
//               test: 'StringEquals',
//               variable: `${url.replace('https://', '')}:aud`,
//               values: ['sts.amazonaws.com'],
//             },
//           ],
//         },
//       ],
//     }),
//   ).json,
// })
// new aws.iam.RolePolicyAttachment(`${s3MountpointDriverRoleName}-attachment`, {
//   role: s3MountpointDriverRole,
//   policyArn: aws.iam.ManagedPolicies.AmazonS3FullAccess,
// })
// new aws.eks.Addon(nm('s3-mountpoint-driver'), {
//   addonName: 'aws-mountpoint-s3-csi-driver',
//   clusterName: eksCluster.name,
//   addonVersion: eksCluster.version.apply(
//     async (kubernetesVersion) =>
//       await aws.eks.getAddonVersion({
//         addonName: 'aws-mountpoint-s3-csi-driver',
//         kubernetesVersion,
//         mostRecent: true,
//       }),
//   ).version,
//   serviceAccountRoleArn: s3MountpointDriverRole.arn,
//   resolveConflictsOnUpdate: 'OVERWRITE',
// })

// === EKS === Addons === Snapshot Controller ===

new aws.eks.Addon(nm('snapshot-controller'), {
  addonName: 'snapshot-controller',
  clusterName: eksCluster.name,
  addonVersion: eksCluster.version.apply(
    async (kubernetesVersion) =>
      await aws.eks.getAddonVersion({
        addonName: 'snapshot-controller',
        kubernetesVersion,
        mostRecent: true,
      }),
  ).version,
  resolveConflictsOnUpdate: 'OVERWRITE',
})

// === EC2 === Interruption Queue ===

const EC2InterruptionQueueName = nm('ec2-interruption-queue')
const EC2InterruptionQueue = new aws.sqs.Queue(EC2InterruptionQueueName, {
  messageRetentionSeconds: 300,
  sqsManagedSseEnabled: true,
})
const EC2InterruptionQueuePolicyName = `${EC2InterruptionQueueName}-policy`
new aws.sqs.QueuePolicy(EC2InterruptionQueuePolicyName, {
  queueUrl: EC2InterruptionQueue.id,
  policy: {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: ['events.amazonaws.com', 'sqs.amazonaws.com'],
        },
        Action: 'sqs:SendMessage',
        Resource: EC2InterruptionQueue.arn,
      },
    ],
  },
})

const scheduledChangeRuleName = nm('scheduled-change-rule')
const scheduledChangeRule = new aws.cloudwatch.EventRule(scheduledChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.health'],
    'detail-type': ['AWS Health Event'],
  }),
})
new aws.cloudwatch.EventTarget(scheduledChangeRuleName, {
  rule: scheduledChangeRule.name,
  arn: EC2InterruptionQueue.arn,
})

const spotInterruptionRuleName = nm('spot-interruption-rule')
const spotInterruptionRule = new aws.cloudwatch.EventRule(spotInterruptionRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Spot Instance Interruption Warning'],
  }),
})
new aws.cloudwatch.EventTarget(spotInterruptionRuleName, {
  rule: spotInterruptionRule.name,
  arn: EC2InterruptionQueue.arn,
})

const rebalanceRuleName = nm('rebalance-rule')
const rebalanceRule = new aws.cloudwatch.EventRule(rebalanceRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance Rebalance Recommendation'],
  }),
})
new aws.cloudwatch.EventTarget(rebalanceRuleName, {
  rule: rebalanceRule.name,
  arn: EC2InterruptionQueue.arn,
})

const instanceStateChangeRuleName = nm('instance-state-change-rule')
const instanceStateChangeRule = new aws.cloudwatch.EventRule(instanceStateChangeRuleName, {
  eventPattern: JSON.stringify({
    source: ['aws.ec2'],
    'detail-type': ['EC2 Instance State-change Notification'],
  }),
})
new aws.cloudwatch.EventTarget(instanceStateChangeRuleName, {
  rule: instanceStateChangeRule.name,
  arn: EC2InterruptionQueue.arn,
})

// === EKS === Karpenter === Controller Role ===

interface KarpenterControllerPolicyProps {
  partitionId: string
  regionId: string
  accountId: string
  eksClusterName: string
  eksNodeRoleName: string
  ec2InterruptionQueueName: string
}

const karpenterControllerPolicy = ({
  partitionId,
  regionId,
  accountId,
  eksClusterName,
  eksNodeRoleName,
  ec2InterruptionQueueName,
}: KarpenterControllerPolicyProps) =>
  aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: 'AllowScopedEC2InstanceAccessActions',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}::image/*`,
          `arn:${partitionId}:ec2:${regionId}::snapshot/*`,
          `arn:${partitionId}:ec2:${regionId}:*:security-group/*`,
          `arn:${partitionId}:ec2:${regionId}:*:subnet/*`,
        ],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
      },
      {
        sid: 'AllowScopedEC2LaunchTemplateAccessActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:launch-template/*`],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedEC2InstanceActionsWithTags',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
          `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`,
        ],
        actions: ['ec2:RunInstances', 'ec2:CreateFleet', 'ec2:CreateLaunchTemplate'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedResourceCreationTagging',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:fleet/*`,
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:volume/*`,
          `arn:${partitionId}:ec2:${regionId}:*:network-interface/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
          `arn:${partitionId}:ec2:${regionId}:*:spot-instances-request/*`,
        ],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'ec2:CreateAction',
            values: ['RunInstances', 'CreateFleet', 'CreateLaunchTemplate'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedResourceTagging',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ec2:${regionId}:*:instance/*`],
        actions: ['ec2:CreateTags'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
          {
            test: 'ForAllValues:StringEquals',
            variable: 'aws:TagKeys',
            values: ['karpenter.sh/nodeclaim', 'Name'],
          },
        ],
      },
      {
        sid: 'AllowScopedDeletion',
        effect: 'Allow',
        resources: [
          `arn:${partitionId}:ec2:${regionId}:*:instance/*`,
          `arn:${partitionId}:ec2:${regionId}:*:launch-template/*`,
        ],
        actions: ['ec2:TerminateInstances', 'ec2:DeleteLaunchTemplate'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.sh/nodepool',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowRegionalReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: [
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeImages',
          'ec2:DescribeInstances',
          'ec2:DescribeInstanceTypeOfferings',
          'ec2:DescribeInstanceTypes',
          'ec2:DescribeLaunchTemplates',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeSpotPriceHistory',
          'ec2:DescribeSubnets',
        ],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'aws:RequestedRegion',
            values: [regionId],
          },
        ],
      },
      {
        sid: 'AllowSSMReadActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:ssm:${regionId}::parameter/aws/service/*`],
        actions: ['ssm:GetParameter'],
      },
      {
        sid: 'AllowPricingReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['pricing:GetProducts'],
      },
      {
        sid: 'AllowInterruptionQueueActions',
        effect: 'Allow',
        resources: [`arn:${partitionId}:sqs:${regionId}:${accountId}:${ec2InterruptionQueueName}`],
        actions: ['sqs:DeleteMessage', 'sqs:GetQueueUrl', 'sqs:ReceiveMessage'],
      },
      {
        sid: 'AllowPassingInstanceRole',
        effect: 'Allow',
        resources: [`arn:${partitionId}:iam::${accountId}:role/${eksNodeRoleName}`],
        actions: ['iam:PassRole'],
        conditions: [
          {
            test: 'StringEquals',
            variable: 'iam:PassedToService',
            values: ['ec2.amazonaws.com'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileCreationActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:CreateInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileTagActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:TagInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringEquals',
            variable: `aws:RequestTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:RequestTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
          {
            test: 'StringLike',
            variable: 'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowScopedInstanceProfileActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:DeleteInstanceProfile'],
        conditions: [
          {
            test: 'StringEquals',
            variable: `aws:ResourceTag/kubernetes.io/cluster/${eksClusterName}`,
            values: ['owned'],
          },
          {
            test: 'StringEquals',
            variable: 'aws:ResourceTag/topology.kubernetes.io/region',
            values: [regionId],
          },
          {
            test: 'StringLike',
            variable: 'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass',
            values: ['*'],
          },
        ],
      },
      {
        sid: 'AllowInstanceProfileReadActions',
        effect: 'Allow',
        resources: ['*'],
        actions: ['iam:GetInstanceProfile'],
      },
      {
        sid: 'AllowAPIServerEndpointDiscovery',
        effect: 'Allow',
        resources: [`arn:${partitionId}:eks:${regionId}:${accountId}:cluster/${eksClusterName}`],
        actions: ['eks:DescribeCluster'],
      },
    ],
  })

const karpenterControllerPolicyName = nm('karpenter-controller-policy')
const KarpenterControllerPolicy = new aws.iam.Policy(karpenterControllerPolicyName, {
  policy: pulumi.all([eksCluster.name, EC2InterruptionQueue.name, eksInstanceRole.name]).apply(
    ([eksClusterName, ec2InterruptionQueueName, eksNodeRoleName]) =>
      karpenterControllerPolicy({
        partitionId,
        regionId,
        accountId,
        eksClusterName: eksClusterName,
        eksNodeRoleName,
        ec2InterruptionQueueName,
      }).json,
  ),
})
const karpenterControllerRoleName = nm('karpenter-controller-role')
const karpenterControllerRole = new aws.iam.Role(karpenterControllerRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(karpenterControllerRoleName, {
  policyArn: KarpenterControllerPolicy.arn,
  role: karpenterControllerRole,
})
new aws.eks.PodIdentityAssociation(nm('karpenter-controller-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'karpenter',
  roleArn: karpenterControllerRole.arn,
})

// === EKS === Karpenter ===

const karpenterCRD = new k8s.helm.v3.Release(
  nm('karpenter-crd'),
  {
    name: 'karpenter-crd',
    chart: 'oci://public.ecr.aws/karpenter/karpenter-crd',
    namespace: 'kube-system',
    version: '1.5.1',
    maxHistory: 1,
  },
  { provider },
)

const karpenter = new k8s.helm.v3.Release(
  nm('karpenter'),
  {
    name: 'karpenter',
    chart: 'oci://public.ecr.aws/karpenter/karpenter',
    namespace: karpenterCRD.namespace,
    version: karpenterCRD.version,
    maxHistory: 1,
    values: {
      replicas: 2,
      settings: {
        clusterName: eksCluster.name,
        interruptionQueue: EC2InterruptionQueue.name,
        featureGates: {
          spotToSpotConsolidation: true,
        },
      },
      serviceMonitor: {
        enabled: true,
      },
    },
    timeout: 60 * 30,
  },
  {
    provider,
    dependsOn: [karpenterCRD],
  },
)

// === EKS === Karpenter === Node Class ===

const defaultNodeClass = new k8s.apiextensions.CustomResource(
  nm('default-node-class'),
  {
    apiVersion: 'karpenter.k8s.aws/v1',
    kind: 'EC2NodeClass',
    metadata: {
      name: 'default',
    },
    spec: {
      kubelet: {
        podsPerCore: 40,
        maxPods: 150,
      },
      // amiFamily: 'Bottlerocket',
      amiSelectorTerms: [{ alias: 'al2023@latest' }],
      role: eksInstanceRole.name,
      associatePublicIPAddress: false,
      subnetSelectorTerms: privateSubnets.map(({ id }) => ({ id })),
      securityGroupSelectorTerms: [
        {
          id: eksCluster.vpcConfig.clusterSecurityGroupId,
        },
      ],
      tags: config.defaults.tagsAll,
    },
  },
  { provider, dependsOn: [karpenter] },
)

// === EKS === Karpenter === Node Pools ===

// TODO: ensure at-least 1 or certain % of pods are always running on on-demand instances

new k8s.apiextensions.CustomResource(
  nm('spot-node-pool'),
  {
    apiVersion: 'karpenter.sh/v1',
    kind: 'NodePool',
    metadata: {
      name: 'spot',
    },
    spec: {
      template: {
        spec: {
          nodeClassRef: {
            group: 'karpenter.k8s.aws',
            kind: 'EC2NodeClass',
            name: defaultNodeClass.metadata.name,
          },
          startupTaints: [
            {
              key: 'node.cilium.io/agent-not-ready',
              value: 'true',
              effect: 'NoExecute',
            },
          ],
          expireAfter: `${24 * 28}h`,
          terminationGracePeriod: '24h',
          requirements: [
            // {
            //   key: 'node.sdp.aws/capacity-type',
            //   operator: 'In',
            //   values: ['spot'],
            // },
            // {
            //   key: 'node.sdp.aws/capacity-partition',
            //   operator: 'In',
            //   values: ['spot-1'],
            // },
            {
              key: 'kubernetes.io/arch',
              operator: 'In',
              values: ['arm64', 'amd64'],
            },
            // avoid allocating too many small instances
            // TODO: https://github.com/kubernetes-sigs/karpenter/issues/1664
            // TODO: https://github.com/kubernetes-sigs/karpenter/issues/919
            // {
            //   key: 'karpenter.k8s.aws/instance-memory',
            //   operator: 'Gt',
            //   values: [`${2 * 1024 - 1}`],
            // },
            {
              key: 'kubernetes.io/os',
              operator: 'In',
              values: ['linux'],
            },
            {
              key: 'karpenter.sh/capacity-type',
              operator: 'In',
              values: ['spot', 'on-demand'], // keep on-demand as a fallback
            },
            {
              key: 'karpenter.k8s.aws/instance-hypervisor',
              operator: 'In',
              values: ['nitro'],
            },
          ],
        },
      },
      limits: {
        cpu: '24',
        memory: '72Gi',
      },
      disruption: {
        consolidationPolicy: 'WhenEmptyOrUnderutilized',
        consolidateAfter: '10m',
      },
      weight: 100,
    },
  },
  { provider, dependsOn: [defaultNodeClass] },
)

// new k8s.apiextensions.CustomResource(
//   nm('on-demand-node-pool'),
//   {
//     apiVersion: 'karpenter.sh/v1',
//     kind: 'NodePool',
//     metadata: {
//       name: 'on-demand',
//     },
//     spec: {
//       template: {
//         spec: {
//           nodeClassRef: {
//             group: 'karpenter.k8s.aws',
//             kind: 'EC2NodeClass',
//             name: defaultNodeClass.metadata.name,
//           },
//           taints: [
//             {
//               key: 'node.sdp.aws/reserved',
//               value: 'dedicated',
//               effect: 'PreferNoSchedule',
//             },
//           ],
//           startupTaints: [
//             {
//               key: 'node.cilium.io/agent-not-ready',
//               value: 'true',
//               effect: 'NoExecute',
//             },
//           ],
//           expireAfter: `${24 * 30}h`,
//           terminationGracePeriod: '24h',
//           requirements: [
//             {
//               key: 'node.sdp.aws/capacity-type',
//               operator: 'In',
//               values: ['on-demand'],
//             },
//             {
//               key: 'node.sdp.aws/capacity-partition',
//               operator: 'In',
//               values: ['on-demand-1'],
//             },
//             {
//               key: 'kubernetes.io/arch',
//               operator: 'In',
//               values: ['arm64', 'amd64'],
//             },
//             {
//               key: 'karpenter.k8s.aws/instance-memory',
//               operator: 'Gt',
//               values: [`${4 * 1024 - 1}`],
//             },
//             {
//               key: 'kubernetes.io/os',
//               operator: 'In',
//               values: ['linux'],
//             },
//             {
//               key: 'karpenter.sh/capacity-type',
//               operator: 'In',
//               values: ['on-demand'],
//             },
//             {
//               key: 'karpenter.k8s.aws/instance-hypervisor',
//               operator: 'In',
//               values: ['nitro'],
//             },
//           ],
//         },
//       },
//       limits: {
//         cpu: '16',
//         memory: '64Gi',
//       },
//       disruption: {
//         consolidationPolicy: 'WhenEmptyOrUnderutilized',
//         consolidateAfter: '10m',
//       },
//       weight: 50,
//     },
//   },
//   { provider, dependsOn: [defaultNodeClass] },
// )

// === EKS === Vertical Pod Autoscaler ===

const vpaNamespace = new k8s.core.v1.Namespace(nm('vpa'), { metadata: { name: 'vpa' } }, { provider })
const vpa = new k8s.helm.v3.Release(
  nm('vertical-pod-autoscaler'),
  {
    name: 'vertical-pod-autoscaler',
    version: '1.9.1',
    chart: 'oci://ghcr.io/stevehipwell/helm-charts/vertical-pod-autoscaler',
    namespace: vpaNamespace.metadata.name,
    maxHistory: 1,
    values: {
      recommender: {
        extraArgs: [
          '--kube-api-burst=100',
          '--kube-api-qps=50',
          '--oom-bump-up-ratio=2',
          '--oom-min-bump-up-bytes=524288000',
        ],
      },
      admissionController: {
        certManager: {
          enabled: true,
        },
      },
    },
  },
  { provider },
)

// === EKS === ECR Pull Through Cache ===

export const ecrK8sPullThroughCacheRule = new aws.ecr.PullThroughCacheRule(nm('ecr-k8s-pull-through-cache'), {
  upstreamRegistryUrl: 'registry.k8s.io',
  ecrRepositoryPrefix: 'registry.k8s.io',
})

const dockerioSecretName = 'ecr-pullthroughcache/docker-hub'
const dockerioSecret = new aws.secretsmanager.Secret(nm(dockerioSecretName), {
  name: dockerioSecretName,
})
new aws.secretsmanager.SecretVersion(nm(dockerioSecretName), {
  secretId: dockerioSecret.id,
  secretString: config.dockerRegistry.token.apply((accessToken) =>
    JSON.stringify({
      username: config.dockerRegistry.username,
      accessToken,
    }),
  ),
})
export const ecrDockerIoPullThroughCacheRule = new aws.ecr.PullThroughCacheRule(
  nm('ecr-docker-io-pull-through-cache'),
  {
    upstreamRegistryUrl: 'registry-1.docker.io',
    ecrRepositoryPrefix: 'docker.io',
    credentialArn: dockerioSecret.arn,
  },
)

const ecrPrivateRegistryUrl = `${accountId}.dkr.ecr.${regionId}.amazonaws.com`

// === EKS === Kyverno ===

const kyvernoNamespace = new k8s.core.v1.Namespace(nm('kyverno'), { metadata: { name: 'kyverno' } }, { provider })
const kyverno = new k8s.helm.v3.Release(
  nm('kyverno'),
  {
    name: 'kyverno',
    chart: 'kyverno',
    version: '3.3.6',
    namespace: kyvernoNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://kyverno.github.io/kyverno/',
    },
    maxHistory: 1,
    values: {
      config: {
        defaultRegistry: pulumi.interpolate`${ecrPrivateRegistryUrl}/${ecrDockerIoPullThroughCacheRule.ecrRepositoryPrefix}`,
        enableDefaultRegistryMutation: true,
      },
    },
  },
  { provider },
)

const kyvernoRbacRules = [
  {
    apiGroups: ['keda.sh'],
    resources: ['scaledobjects'],
    verbs: ['*'],
  },
  {
    apiGroups: ['autoscaling.k8s.io'],
    resources: ['verticalpodautoscalers'],
    verbs: ['*'],
  },
  {
    apiGroups: ['apps'],
    resources: ['deployments', 'statefulsets'],
    verbs: ['*'],
  },
]
new k8s.rbac.v1.ClusterRole(
  nm('kyverno-background-controller-rbac-extras'),
  {
    metadata: {
      name: 'kyverno:background-controller-rbac-extras',
      labels: {
        'rbac.kyverno.io/aggregate-to-background-controller': 'true',
      },
    },
    rules: kyvernoRbacRules,
  },
  { provider },
)
new k8s.rbac.v1.ClusterRole(
  nm('kyverno-admission-controller-rbac-extras'),
  {
    metadata: {
      name: 'kyverno:admission-controller-rbac-extras',
      labels: {
        'rbac.kyverno.io/aggregate-to-admission-controller': 'true',
      },
    },
    rules: kyvernoRbacRules,
  },
  { provider },
)

// TODO: enable kyverno policies from https://github.com/kyverno/policies
// TODO: use a directory of policies to apply with ArgoCD

// === EKS === Limit Range === All Namespaces ===

const addNamespaceLimitRange = 'add-namespace-limit-range'
new k8s.apiextensions.CustomResource(
  nm(addNamespaceLimitRange),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: addNamespaceLimitRange,
      annotations: {
        'policies.kyverno.io/title': 'Add LimitRange to Namespaces',
        'policies.kyverno.io/category': 'Other',
        'policies.kyverno.io/severity': 'medium',
        'kyverno.io/kyverno-version': kyverno.version,
        'kyverno.io/kubernetes-version': eksCluster.version,
        'policies.kyverno.io/subject': 'LimitRange',
        'policies.kyverno.io/description': `Pods which don't specify at least resource requests are assigned a QoS class of BestEffort which can hog resources for other Pods on Nodes. At a minimum, all Pods should specify resource requests in order to be labeled as the QoS class Burstable. This policy creates a LimitRange policy in each Namespace to ensure some default values are set.`,
      },
    },
    spec: {
      generateExisting: true,
      useServerSideApply: true,
      rules: [
        {
          name: addNamespaceLimitRange,
          match: {
            resources: {
              kinds: ['Namespace'],
            },
          },
          generate: {
            apiVersion: 'v1',
            kind: 'LimitRange',
            name: '{{request.object.metadata.name}}-limits',
            namespace: '{{request.object.metadata.name}}',
            synchronize: true,
            data: {
              spec: {
                limits: [
                  {
                    default: config.defaults.pod.resources.limits,
                    defaultRequest: config.defaults.pod.resources.requests,
                    type: 'Container',
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === EKS === Use ECR Pull Through Cache ===

const useECRPullThroughCache = 'use-ecr-pull-through-cache'
new k8s.apiextensions.CustomResource(
  nm(useECRPullThroughCache),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: useECRPullThroughCache,
      annotations: {
        'policies.kyverno.io/title': 'Use ECR Pull Through Cache',
        'policies.kyverno.io/category': 'Other',
        'policies.kyverno.io/severity': 'medium',
        'kyverno.io/kyverno-version': kyverno.version,
        'kyverno.io/kubernetes-version': eksCluster.version,
        'policies.kyverno.io/subject': 'ImageRegistry',
        'policies.kyverno.io/description': `This policy ensures that all Pods use the ECR Pull Through Cache to reduce latency and improve performance.`,
      },
    },
    spec: {
      rules: [
        {
          name: useECRPullThroughCache,
          match: {
            any: [
              {
                resources: {
                  kinds: ['Pod'],
                },
              },
            ],
          },
          mutate: {
            foreach: ['ephemeralContainers', 'initContainers', 'containers'].map((key) => ({
              list: `request.object.spec.${key} || []`,
              preconditions: {
                all: [
                  {
                    key: `{{ images.${key}."{{element.name}}".registry }}`,
                    operator: 'AnyIn',
                    value: ['docker.io', 'registry.k8s.io'],
                  },
                ],
              },
              context: [
                {
                  name: 'registry',
                  variable: {
                    value: `{{ images.${key}."{{element.name}}".registry }}`,
                  },
                },
                {
                  name: 'namespace',
                  variable: {
                    value: `{{ images.${key}."{{element.name}}".path | contains(@, '/') && split(@, '/')[0] || 'library' }}`,
                  },
                },
                {
                  name: 'repository',
                  variable: {
                    value: `{{ images.${key}."{{element.name}}".path | contains(@, '/') && split(@, '/')[1] || @ }}`,
                  },
                },
                {
                  name: 'tag',
                  variable: {
                    value: `{{ images.${key}."{{element.name}}".tag || 'latest' }}`,
                  },
                },
                {
                  name: 'digest',
                  variable: {
                    value: `{{ images.${key}."{{element.name}}".digest || '' }}`,
                  },
                },
                {
                  name: 'ref',
                  variable: {
                    value: `{{ digest && '{{ tag }}@{{ digest }}' || tag }}`,
                  },
                },
              ],
              patchStrategicMerge: {
                spec: {
                  [key]: [
                    {
                      name: '{{ element.name }}',
                      image: `{{ regex_replace_all('^([^/]*)/([^/]*)/([^:]*):(.*)', '{{ registry }}/{{ namespace }}/{{ repository }}:{{ ref }}', '${ecrPrivateRegistryUrl}/$1/$2/$3:$4') }}`,
                    },
                  ],
                },
              },
            })),
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === EKS === Spread Pods ===

const spreadPodsPolicyName = 'spread-pods'
new k8s.apiextensions.CustomResource(
  nm(spreadPodsPolicyName),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: spreadPodsPolicyName,
      annotations: {
        'policies.kyverno.io/title': 'Spread Pods',
        'policies.kyverno.io/subject': 'Deployment, Pod',
        'policies.kyverno.io/description': `This policy ensures that Pods are spread across Nodes in the cluster. This is important for high availability and fault tolerance.`,
      },
    },
    spec: {
      rules: [
        {
          name: spreadPodsPolicyName,
          match: {
            resources: {
              kinds: ['Deployment', 'StatefulSet'],
            },
          },
          // preconditions: {
          //   all: [
          //     {
          //       key: '{{ request.object.spec.replicas }}',
          //       operator: 'GreaterThanOrEquals',
          //       value: 2,
          //     },
          //   ],
          // },
          mutate: {
            patchStrategicMerge: {
              spec: {
                template: {
                  spec: {
                    '+(topologySpreadConstraints)': [
                      {
                        maxSkew: 1,
                        topologyKey: 'kubernetes.io/hostname',
                        whenUnsatisfiable: 'DoNotSchedule',
                        labelSelector: '{{request.object.spec.selector}}',
                        matchLabelKeys: ['pod-template-hash', 'controller-revision-hash'],
                      },
                      {
                        maxSkew: 1,
                        topologyKey: 'topology.kubernetes.io/zone',
                        whenUnsatisfiable: 'ScheduleAnyway',
                        labelSelector: '{{request.object.spec.selector}}',
                        matchLabelKeys: ['pod-template-hash', 'controller-revision-hash'],
                      },
                      // {
                      //   maxSkew: 1,
                      //   topologyKey: 'node.sdp.aws/capacity-partition',
                      //   whenUnsatisfiable: 'ScheduleAnyway',
                      //   labelSelector: '{{request.object.spec.selector}}',
                      //   matchLabelKeys: ['pod-template-hash', 'controller-revision-hash'],
                      // },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === EKS === Unset CPU Limits ===

// const unsetCPULimits = 'unset-cpu-limits'
// new k8s.apiextensions.CustomResource(
//   nm(unsetCPULimits),
//   {
//     apiVersion: 'kyverno.io/v1',
//     kind: 'ClusterPolicy',
//     metadata: {
//       name: unsetCPULimits,
//       annotations: {
//         'kyverno.io/kyverno-version': kyverno.version,
//         'kyverno.io/kubernetes-version': eksCluster.version,
//       },
//     },
//     spec: {
//       rules: [
//         {
//           name: unsetCPULimits,
//           match: {
//             any: [
//               {
//                 resources: {
//                   kinds: ['Deployment', 'StatefulSet'],
//                 },
//               },
//             ],
//           },
//           mutate: {
//             mutateExistingOnPolicyUpdate: true,
//             targets: [
//               {
//                 apiVersion: 'apps/v1',
//                 kind: '{{request.object.kind}}',
//                 namespace: '{{request.object.metadata.namespace}}',
//               },
//             ],
//             foreach: [
//               {
//                 list: 'request.object.spec.template.spec.[containers, initContainers, ephemeralContainers][]',
//                 patchStrategicMerge: {
//                   spec: {
//                     template: {
//                       spec: {
//                         containers: [
//                           {
//                             '(name)': '{{ element.name }}',
//                             resources: {
//                               limits: {
//                                 $patch: 'replace',
//                                 memory: '192Mi',
//                               },
//                               requests: {
//                                 cpu: '20m',
//                                 memory: '192Mi',
//                               },
//                             },
//                           },
//                         ],
//                       },
//                     },
//                   },
//                 },
//               },
//             ],
//           },
//         },
//       ],
//     },
//   },
//   { provider, dependsOn: [kyverno] },
// )

// === EKS === Vertical Pod Autoscaler ===

const vpaForAll = 'vpa-for-all'
new k8s.apiextensions.CustomResource(
  nm(vpaForAll),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: vpaForAll,
      annotations: {
        'kyverno.io/kyverno-version': kyverno.version,
        'kyverno.io/kubernetes-version': eksCluster.version,
      },
    },
    spec: {
      generateExisting: true,
      useServerSideApply: true,
      rules: [
        {
          name: vpaForAll,
          match: {
            resources: {
              kinds: ['Deployment', 'StatefulSet'],
            },
          },
          exclude: {
            resources: {
              names: ['moodle', 'moodle-cache', 'shlink-cache'],
            },
          },
          generate: {
            apiVersion: 'autoscaling.k8s.io/v1',
            kind: 'VerticalPodAutoscaler',
            name: '{{request.object.metadata.name}}',
            namespace: '{{request.object.metadata.namespace}}',
            synchronize: true,
            data: {
              spec: {
                targetRef: {
                  apiVersion: 'apps/v1',
                  kind: '{{request.object.kind}}',
                  name: '{{request.object.metadata.name}}',
                },
                updatePolicy: {
                  updateMode: 'Auto',
                  // updateMode: 'Off',
                  minReplicas: 1,
                },
                resourcePolicy: {
                  containerPolicies: [
                    {
                      containerName: '*',
                      maxAllowed: {
                        cpu: '2',
                        memory: '4Gi',
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === EKS === Priority Class ===

const platformPriorityClassBaseline = 1000_000_000 / 2

// === EKS === Priority Class === All DaemonSets ===

const allDaemonsetDefaultPriorityClass = 'all-daemonset-default'
new k8s.scheduling.v1.PriorityClass(
  nm(allDaemonsetDefaultPriorityClass),
  {
    metadata: {
      name: allDaemonsetDefaultPriorityClass,
    },
    value: platformPriorityClassBaseline + 1000,
    globalDefault: false,
    description: 'Default priority class for DaemonSets',
    preemptionPolicy: 'PreemptLowerPriority',
  },
  { provider },
)

const addDefaultDaemonsetPriorityClass = 'add-priority-class-to-daemonsets'
new k8s.apiextensions.CustomResource(
  nm(addDefaultDaemonsetPriorityClass),
  {
    apiVersion: 'kyverno.io/v1',
    kind: 'ClusterPolicy',
    metadata: {
      name: addDefaultDaemonsetPriorityClass,
      annotations: {
        'policies.kyverno.io/title': 'Add PriorityClass to DaemonSets',
        'policies.kyverno.io/category': 'Other',
        'policies.kyverno.io/severity': 'medium',
        'kyverno.io/kyverno-version': kyverno.version,
        'kyverno.io/kubernetes-version': eksCluster.version,
        'policies.kyverno.io/subject': 'PriorityClass',
        'policies.kyverno.io/description': `DaemonSets are critical to the functioning of the cluster. This policy ensures that all DaemonSets have a PriorityClass set to ensure they are not evicted and more likely to be scheduled.`,
      },
    },
    spec: {
      rules: [
        {
          name: addDefaultDaemonsetPriorityClass,
          match: {
            resources: {
              kinds: ['DaemonSet'],
            },
          },
          mutate: {
            patchStrategicMerge: {
              spec: {
                template: {
                  spec: {
                    '+(priorityClassName)': allDaemonsetDefaultPriorityClass,
                  },
                },
              },
            },
          },
        },
      ],
    },
  },
  { provider, dependsOn: [kyverno] },
)

// === EKS === External System ===

const externalSystemNamespace = new k8s.core.v1.Namespace(
  nm('external-system'),
  { metadata: { name: 'external-system' } },
  { provider },
)

// === EKS === External System === External Secrets ===

const eso = new k8s.helm.v3.Release(
  nm('external-secrets'),
  {
    name: 'external-secrets',
    chart: 'external-secrets',
    version: '0.9.18',
    namespace: externalSystemNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://charts.external-secrets.io',
    },
    maxHistory: 1,
    values: {
      installCRDs: true,
    },
  },
  { provider },
)

const esoSARole = new aws.iam.Role(nm('external-secrets-role'), {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
const esoRoleName = nm('external-secrets-operator-role')
const esoRole = new aws.iam.Role(esoRoleName, {
  assumeRolePolicy: {
    Version: '2012-10-17',
    Statement: [
      {
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Effect: 'Allow',
        Principal: {
          AWS: esoSARole.arn,
        },
      },
    ],
  },
})
const esoPolicyName = nm('external-secrets-policy')
const esoPolicy = new aws.iam.Policy(esoPolicyName, {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: [
            'secretsmanager:GetResourcePolicy',
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:ListSecretVersionIds',
            'secretsmanager:ListSecrets',
          ],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
new aws.iam.RolePolicyAttachment(esoRoleName, {
  policyArn: esoPolicy.arn,
  role: esoRole,
})
new aws.eks.PodIdentityAssociation(nm('external-secrets-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: externalSystemNamespace.metadata.name,
  serviceAccount: 'external-secrets',
  roleArn: esoSARole.arn,
})

const clusterSecretStoreAWS = 'aws-secrets-store'
new k8s.apiextensions.CustomResource(
  nm(clusterSecretStoreAWS),
  {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ClusterSecretStore',
    metadata: {
      name: clusterSecretStoreAWS,
    },
    spec: {
      provider: {
        aws: {
          service: 'SecretsManager',
          region: regionId,
          role: esoRole.arn,
        },
      },
    },
  },
  { provider, dependsOn: [eso] },
)

// === EKS === External System === External DNS ===

const externalDNS = new k8s.helm.v3.Release(
  nm('external-dns'),
  {
    name: 'external-dns',
    chart: 'external-dns',
    namespace: externalSystemNamespace.metadata.name,
    version: '1.14.4',
    repositoryOpts: {
      repo: 'https://kubernetes-sigs.github.io/external-dns/',
    },
    maxHistory: 1,
    values: {
      serviceAccount: {
        create: true,
        name: 'external-dns',
      },
    },
  },
  { provider },
)

const externalDNSPolicyName = nm('external-dns-policy')
const externalDNSPolicy = new aws.iam.Policy(externalDNSPolicyName, {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: ['route53:ChangeResourceRecordSets'],
          resources: ['arn:aws:route53:::hostedzone/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ListHostedZones', 'route53:ListResourceRecordSets', 'route53:ListTagsForResource'],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
const externalDNSRoleName = nm('external-dns-role')
const externalDNSRole = new aws.iam.Role(externalDNSRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(externalDNSRoleName, {
  policyArn: externalDNSPolicy.arn,
  role: externalDNSRole,
})
new aws.eks.PodIdentityAssociation(nm('external-dns-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: externalSystemNamespace.metadata.name,
  serviceAccount: 'external-dns',
  roleArn: externalDNSRole.arn,
})

// === EKS === Cert Manager ===

const certManager = new k8s.helm.v3.Release(
  nm('cert-manager'),
  {
    name: 'cert-manager',
    chart: 'cert-manager',
    namespace: 'cert-manager',
    version: 'v1.18.0',
    repositoryOpts: {
      repo: 'https://charts.jetstack.io',
    },
    maxHistory: 1,
    values: {
      installCRDs: true,
      enableCertificateOwnerRef: true,
      extraArgs: [
        '--enable-certificate-owner-ref=true',
        '--dns01-recursive-nameservers-only',
        '--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53',
      ],
      securityContext: {
        fsGroup: 1001,
      },
    },
    createNamespace: true,
  },
  { provider },
)

const certManagerDns01Policy = new aws.iam.Policy(nm('cert-manager-dns01-policy'), {
  policy: aws.iam
    .getPolicyDocument({
      statements: [
        {
          effect: 'Allow',
          actions: ['route53:GetChange'],
          resources: ['arn:aws:route53:::change/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets'],
          resources: ['arn:aws:route53:::hostedzone/*'],
        },
        {
          effect: 'Allow',
          actions: ['route53:ListHostedZonesByName'],
          resources: ['*'],
        },
      ],
    })
    .then((doc) => doc.json),
})
const certManagerDns01RoleName = nm('cert-manager-dns01-role')
const certManagerDns01Role = new aws.iam.Role(certManagerDns01RoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
new aws.iam.RolePolicyAttachment(nm('cert-manager-dns01-role-policy'), {
  policyArn: certManagerDns01Policy.arn,
  role: certManagerDns01Role,
})
new aws.eks.PodIdentityAssociation(nm('cert-manager-dns01-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'cert-manager',
  serviceAccount: 'cert-manager',
  roleArn: certManagerDns01Role.arn,
})

// === EKS === Cert Manager === Issuers ===

const letsencryptProdIssuerName = 'letsencrypt-prod-issuer'
new k8s.apiextensions.CustomResource(
  letsencryptProdIssuerName,
  {
    apiVersion: 'cert-manager.io/v1',
    kind: 'ClusterIssuer',
    metadata: {
      name: letsencryptProdIssuerName,
    },
    spec: {
      acme: {
        email: config.admin.email,
        server: 'https://acme-v02.api.letsencrypt.org/directory',
        privateKeySecretRef: {
          name: 'letsencrypt-prod-issuer-account-key',
        },
        solvers: [
          {
            selector: {
              dnsZones: config.route53.zones,
            },
            dns01: {
              route53: {
                region: config.route53.region,
              },
            },
          },
        ],
      },
    },
  },
  { provider, dependsOn: [certManager] },
)

const letsencryptStagingIssuerName = 'letsencrypt-staging-issuer'
new k8s.apiextensions.CustomResource(
  letsencryptStagingIssuerName,
  {
    apiVersion: 'cert-manager.io/v1',
    kind: 'ClusterIssuer',
    metadata: {
      name: letsencryptStagingIssuerName,
    },
    spec: {
      acme: {
        email: config.admin.email,
        server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
        privateKeySecretRef: {
          name: 'letsencrypt-staging-issuer-account-key',
        },
        solvers: [
          {
            selector: {
              dnsZones: config.route53.zones,
            },
            dns01: {
              route53: {
                region: config.route53.region,
              },
            },
          },
        ],
      },
    },
  },
  { provider, dependsOn: [certManager] },
)

const zerosslProdIssuerName = 'zerossl-prod-issuer'
const zerosslProdIssuerSecret = new k8s.core.v1.Secret(
  zerosslProdIssuerName,
  {
    metadata: {
      name: zerosslProdIssuerName,
      namespace: 'cert-manager',
    },
    stringData: {
      secret: config.zerossl.secret,
    },
  },
  { provider },
)
new k8s.apiextensions.CustomResource(
  zerosslProdIssuerName,
  {
    apiVersion: 'cert-manager.io/v1',
    kind: 'ClusterIssuer',
    metadata: {
      name: zerosslProdIssuerName,
    },
    spec: {
      acme: {
        server: 'https://acme.zerossl.com/v2/DV90',
        externalAccountBinding: {
          keyID: config.zerossl.key,
          keySecretRef: {
            name: zerosslProdIssuerSecret.metadata.name,
            key: 'secret',
          },
        },
        privateKeySecretRef: {
          name: `${zerosslProdIssuerName}-account-key`,
        },
        solvers: [
          {
            selector: {
              dnsZones: config.route53.zones,
            },
            dns01: {
              route53: {
                region: config.route53.region,
              },
            },
          },
        ],
      },
    },
  },
  { provider, dependsOn: [certManager] },
)

// === EKS === AWS Load Balancer Controller ===

const awsLoadBalancerControllerName = 'aws-load-balancer-controller'
const awsLoadBalancerController = new k8s.helm.v3.Release(
  nm(awsLoadBalancerControllerName),
  {
    name: awsLoadBalancerControllerName,
    chart: 'aws-load-balancer-controller',
    version: '1.8.4',
    namespace: 'kube-system',
    repositoryOpts: {
      repo: 'https://aws.github.io/eks-charts',
    },
    maxHistory: 1,
    values: {
      clusterName: eksCluster.name,
      region: regionId,
      vpcId: eksCluster.vpcConfig.vpcId,
      enableCertManager: true,
    },
  },
  { provider },
)
const awsLoadBalancerControllerRoleName = nm(`${awsLoadBalancerControllerName}-role`)
const awsLoadBalancerControllerRole = new aws.iam.Role(awsLoadBalancerControllerRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
const awsLoadBalancerControllerPolicyName = nm(`${awsLoadBalancerControllerName}-policy`)
const awsLoadBalancerControllerPolicy = new aws.iam.Policy(awsLoadBalancerControllerPolicyName, {
  policy: await fetch(
    'https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json',
  ).then((res) => res.text()),
})
new aws.iam.RolePolicyAttachment(nm(`${awsLoadBalancerControllerName}-role-policy`), {
  policyArn: awsLoadBalancerControllerPolicy.arn,
  role: awsLoadBalancerControllerRole,
})
new aws.eks.PodIdentityAssociation(nm(`${awsLoadBalancerControllerName}-pod-identity`), {
  clusterName: eksCluster.name,
  namespace: 'kube-system',
  serviceAccount: 'aws-load-balancer-controller',
  roleArn: awsLoadBalancerControllerRole.arn,
})

// === EKS === Monitoring ===

const monitoringNamespace = new k8s.core.v1.Namespace(
  nm('monitoring'),
  { metadata: { name: 'monitoring' } },
  { provider },
)

// === EKS === Monitoring === Metrics Server ===

const metricsServer = new k8s.helm.v3.Release(
  nm('metrics-server'),
  {
    name: 'metrics-server',
    chart: 'metrics-server',
    namespace: monitoringNamespace.metadata.name,
    version: '3.12.1',
    repositoryOpts: {
      repo: 'https://kubernetes-sigs.github.io/metrics-server/',
    },
    maxHistory: 1,
    values: {
      resources: config.defaults.pod.resources,
    },
  },
  { provider },
)

// === EKS === Monitoring === Kube Prometheus Stack ===

const thanosBucketName = nm('thanos-metrics')
const thanosBucket = new aws.s3.BucketV2(thanosBucketName, {
  bucketPrefix: `${thanosBucketName}-`,
})
const thanosUser = new aws.iam.User(nm('thanos-user'))
// const thanosAccessKey = new aws.iam.AccessKey(nm('thanos-access-key'), {
//   user: thanosUser.name,
// })
const thanosS3AccessPolicy = new aws.iam.Policy(nm('thanos-policy'), {
  policy: thanosBucket.arn.apply((bucket) =>
    aws.iam
      .getPolicyDocument({
        statements: [
          {
            effect: 'Allow',
            actions: ['s3:ListBucket'],
            resources: [bucket],
          },
          {
            effect: 'Allow',
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            resources: [`${bucket}/*`],
          },
        ],
      })
      .then((doc) => doc.json),
  ),
})
new aws.iam.UserPolicyAttachment(nm('thanos-user-policy'), {
  policyArn: thanosS3AccessPolicy.arn,
  user: thanosUser,
})

// TODO: enable monitoring for all deployments

const grafanaPassword = new random.RandomPassword(nm('grafana-password'), {
  length: 32,
  special: true,
})
// const kubePrometheusStack = new k8s.helm.v3.Release(
//   nm('kube-prometheus-stack'),
//   {
//     name: 'kube-prometheus-stack',
//     chart: 'kube-prometheus-stack',
//     version: '62.3.1',
//     namespace: monitoringNamespace.metadata.name,
//     repositoryOpts: {
//       repo: 'https://prometheus-community.github.io/helm-charts',
//     },
//     maxHistory: 1,
//     values: {
//       prometheus: {
//         prometheusSpec: {
//           serviceMonitorSelectorNilUsesHelmValues: false,
//           podMonitorSelectorNilUsesHelmValues: false,
//           ruleSelectorNilUsesHelmValues: false,
//           probeSelectorNilUsesHelmValues: false,
//           retention: '7d',
//           retentionSize: '10GiB',
//           storageSpec: {
//             volumeClaimTemplate: {
//               metadata: {
//                 name: 'prometheus-storage',
//               },
//               spec: {
//                 accessModes: ['ReadWriteOnce'],
//                 resources: {
//                   requests: {
//                     storage: '12Gi',
//                   },
//                 },
//               },
//             },
//           },
//           thanos: {
//             objectStorageConfig: {
//               secret: {
//                 type: 'S3',
//                 config: {
//                   bucket: thanosBucket.bucket,
//                   endpoint: 's3.amazonaws.com',
//                   region: regionId,
//                   access_key: thanosAccessKey.id,
//                   secret_key: thanosAccessKey.secret,
//                 },
//               },
//             },
//           },
//         },
//         thanosService: {
//           enabled: true,
//         },
//         thanosServiceMonitor: {
//           enabled: true,
//         },
//       },
//       prometheusOperator: {
//         admissionWebhooks: {
//           certManager: {
//             enabled: true,
//           },
//         },
//       },
//       alertmanager: {
//         alertmanagerSpec: {
//           storage: {
//             volumeClaimTemplate: {
//               spec: {
//                 accessModes: ['ReadWriteOnce'],
//                 resources: {
//                   requests: {
//                     storage: '1Gi',
//                   },
//                 },
//               },
//             },
//           },
//         },
//       },
//       grafana: {
//         persistence: {
//           enabled: true,
//         },
//         adminPassword: grafanaPassword.result,
//         'grafana.ini': {
//           users: {
//             viewers_can_edit: true,
//           },
//         },
//         ingress: {
//           enabled: true,
//           hosts: [config.grafana.host],
//           annotations: {
//             'cert-manager.io/cluster-issuer': 'letsencrypt-prod-issuer',
//           },
//           tls: [
//             {
//               secretName: 'grafana-tls',
//               hosts: [config.grafana.host],
//             },
//           ],
//         },
//         defaultDashboardsEditable: false,
//         dashboardProviders: {
//           'dashboardproviders.yaml': {
//             apiVersion: 1,
//             providers: [
//               {
//                 name: 'karperter',
//                 orgId: 1,
//                 folder: 'karpenter',
//                 type: 'file',
//                 disableDeletion: true,
//                 editable: true,
//                 options: {
//                   path: '/var/lib/grafana/dashboards/karpenter',
//                 },
//               },
//             ],
//           },
//         },
//         dashboards: {
//           karpenter: {
//             // TODO: move the dashboard to a local file, as the content may change
//             'karperter-capacity': {
//               url: 'https://karpenter.sh/preview/getting-started/getting-started-with-karpenter/karpenter-capacity-dashboard.json',
//             },
//             'karperter-performance': {
//               url: 'https://karpenter.sh/preview/getting-started/getting-started-with-karpenter/karpenter-performance-dashboard.json',
//             },
//           },
//         },
//       },
//     },
//   },
//   { provider, dependsOn: [certManager] },
// )

// === EKS === Monitoring === Loki ===

const lokiBuckets = ['chunks', 'ruler', 'admin'].reduce(
  (acc, lokiBucketName) => {
    const bucketName = nm(`loki-${lokiBucketName}`)
    return {
      ...acc,
      [lokiBucketName]: new aws.s3.BucketV2(bucketName, {
        bucketPrefix: `${bucketName}-`,
      }),
    }
  },
  {} as Record<string, aws.s3.BucketV2>,
)
const lokiBucketsMap = Object.fromEntries(
  Object.entries(lokiBuckets).map(([lokiBucketName, { bucket }]) => [lokiBucketName, bucket]),
)
const lokiS3RoleName = nm('loki-role')
const lokiS3Role = new aws.iam.Role(lokiS3RoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
const lokiS3AccessPolicy = new aws.iam.Policy(nm('loki-policy'), {
  policy: pulumi.all(Object.values(lokiBucketsMap)).apply((buckets) =>
    aws.iam
      .getPolicyDocument({
        statements: [
          {
            effect: 'Allow',
            actions: ['s3:ListBucket'],
            resources: buckets.map((bucket) => `arn:aws:s3:::${bucket}`),
          },
          {
            effect: 'Allow',
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
            resources: buckets.map((bucket) => `arn:aws:s3:::${bucket}/*`),
          },
        ],
      })
      .then((doc) => doc.json),
  ),
})
new aws.iam.RolePolicyAttachment(nm('loki-role-policy'), {
  policyArn: lokiS3AccessPolicy.arn,
  role: lokiS3Role,
})
new aws.eks.PodIdentityAssociation(nm('loki-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: monitoringNamespace.metadata.name,
  serviceAccount: 'loki',
  roleArn: lokiS3Role.arn,
})

// const loki = new k8s.helm.v3.Release(
//   nm('loki'),
//   {
//     name: 'loki',
//     chart: 'loki',
//     version: '6.10.2',
//     namespace: 'monitoring',
//     repositoryOpts: {
//       repo: 'https://grafana.github.io/helm-charts',
//     },
//     values: {
//       // TODO: fix gateway svc not being accessible properly from grafana
//       // NOTE: https://github.com/grafana/loki/issues/12963
//       gateway: {
//         autoscaling: {
//           enabled: false,
//         },
//       },
//       chunksCache: {
//         // allocatedMemory: '512',
//         // writebackSizeLimit: '64MB',
//         enabled: false,
//       },
//       resultsCache: {
//         enabled: false,
//         // allocatedMemory: '128',
//         // writebackSizeLimit: '64MB',
//       },
//       write: {
//         replicas: 1,
//         resources: {
//           requests: {
//             memory: '256Mi',
//           },
//           limits: {
//             memory: '1Gi',
//           },
//         },
//       },
//       read: {
//         replicas: 1,
//         resources: {
//           requests: {
//             memory: '256Mi',
//           },
//           limits: {
//             memory: '1Gi',
//           },
//         },
//       },
//       loki: {
//         auth_enabled: false,
//         schemaConfig: {
//           configs: [
//             {
//               from: '2024-04-01',
//               store: 'tsdb',
//               object_store: 's3',
//               schema: 'v13',
//               index: {
//                 prefix: 'loki_index_',
//                 period: '24h',
//               },
//             },
//           ],
//         },
//         compactor: {
//           retention_enabled: true,
//           delete_request_store: 's3',
//           compaction_interval: '30m',
//           retention_delete_delay: '2h',
//           retention_delete_worker_count: 150,
//         },
//         limits_config: {
//           retention_period: '7d',
//         },
//         ingester: {
//           chunk_encoding: 'snappy',
//         },
//         storage: {
//           type: 's3',
//           s3: {
//             region: regionId,
//           },
//           bucketNames: lokiBucketsMap,
//         },
//       },
//       deploymentMode: 'SimpleScalable',
//     },
//   },
//   { provider },
// )

// === EKS === Monitoring === Promtail ===

// const promtail = new k8s.helm.v3.Release(
//   nm('promtail'),
//   {
//     name: 'promtail',
//     chart: 'promtail',
//     version: '6.15.5',
//     namespace: monitoringNamespace.metadata.name,
//     repositoryOpts: {
//       repo: 'https://grafana.github.io/helm-charts',
//     },
//     maxHistory: 1,
//     values: {
//       config: {
//         clients: [
//           {
//             url: 'http://loki-gateway/loki/api/v1/push',
//           },
//         ],
//       },
//     },
//   },
//   { provider },
// )

// === EKS === EFS ===

const efs = new aws.efs.FileSystem(nm('efs'), {
  encrypted: true,
  kmsKeyId: kmsKey.arn,
  performanceMode: 'generalPurpose',
  throughputMode: 'elastic',
  tags: {
    Name: nm('efs'),
  },
})
new aws.efs.BackupPolicy(nm('efs-backup-policy'), {
  fileSystemId: efs.id,
  backupPolicy: {
    status: 'ENABLED',
  },
})
privateSubnets.forEach((subnet, index) => {
  new aws.efs.MountTarget(nm(`efs-${index}`), {
    fileSystemId: efs.id,
    subnetId: subnet.id,
    securityGroups: [eksCluster.vpcConfig.clusterSecurityGroupId],
  })
})
new k8s.storage.v1.StorageClass(
  nm('efs'),
  {
    metadata: {
      name: 'efs',
    },
    provisioner: 'efs.csi.aws.com',
    volumeBindingMode: 'WaitForFirstConsumer',
    parameters: {
      fileSystemId: efs.id,
      provisioningMode: 'efs-ap',
      directoryPerms: '700',
      uid: '0',
      gid: '0',
    },
    mountOptions: ['iam'],
  },
  { provider },
)

// === EKS === Velero ===

const veleroBucketName = nm('velero-backup')
const veleroBucket = new aws.s3.BucketV2(veleroBucketName, {
  bucketPrefix: `${veleroBucketName}-`,
})
const veleroBackupRoleName = nm('velero-backup-role')
const veleroBackupRole = new aws.iam.Role(veleroBackupRoleName, {
  assumeRolePolicy: assumeRoleForEKSPodIdentity(),
})
const veleroBackupPolicyName = nm('velero-backup-policy')
const veleroBackupPolicy = new aws.iam.Policy(veleroBackupPolicyName, {
  policy: veleroBucket.arn.apply((bucket) =>
    aws.iam
      .getPolicyDocument({
        statements: [
          {
            effect: 'Allow',
            actions: [
              'ec2:DescribeVolumes',
              'ec2:DescribeSnapshots',
              'ec2:CreateTags',
              'ec2:CreateVolume',
              'ec2:CreateSnapshot',
              'ec2:DeleteSnapshot',
            ],
            resources: ['*'],
          },
          {
            effect: 'Allow',
            actions: [
              's3:GetObject',
              's3:DeleteObject',
              's3:PutObject',
              's3:AbortMultipartUpload',
              's3:ListMultipartUploadParts',
            ],
            resources: [`${bucket}/*`],
          },
          {
            effect: 'Allow',
            actions: ['s3:ListBucket'],
            resources: [bucket],
          },
        ],
      })
      .then((doc) => doc.json),
  ),
})
new aws.iam.RolePolicyAttachment(veleroBackupRoleName, {
  policyArn: veleroBackupPolicy.arn,
  role: veleroBackupRole,
})
new aws.eks.PodIdentityAssociation(nm('velero-backup-pod-identity'), {
  clusterName: eksCluster.name,
  namespace: 'velero',
  serviceAccount: 'velero-server',
  roleArn: veleroBackupRole.arn,
})

// TODO: version upgrade
// NOTE: https://github.com/vmware-tanzu/velero/issues/7892
const veleroNamespace = new k8s.core.v1.Namespace(nm('velero'), { metadata: { name: 'velero' } }, { provider })
const velero = new k8s.helm.v3.Release(
  nm('velero'),
  {
    name: 'velero',
    chart: 'velero',
    version: '8.4.0',
    namespace: veleroNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://vmware-tanzu.github.io/helm-charts',
    },
    maxHistory: 1,
    values: {
      configuration: {
        backupStorageLocation: [
          {
            name: 'default',
            provider: 'aws',
            bucket: veleroBucket.bucket,
            config: {
              region: regionId,
            },
          },
        ],
        volumeSnapshotLocation: [
          {
            name: 'default',
            provider: 'aws',
            config: {
              region: regionId,
            },
          },
        ],
      },
      snapshotsEnabled: true,
      backupsEnabled: true,
      initContainers: [
        {
          name: 'velero-plugin-for-aws',
          image: 'velero/velero-plugin-for-aws:v1.11.1',
          volumeMounts: [
            {
              mountPath: '/target',
              name: 'plugins',
            },
          ],
        },
      ],
      deployNodeAgent: true,
    },
  },
  { provider },
)

// === EKS === Keda ===

const kedaNamespace = new k8s.core.v1.Namespace(nm('keda'), { metadata: { name: 'keda' } }, { provider })
const keda = new k8s.helm.v3.Release(
  nm('keda'),
  {
    name: 'keda',
    chart: 'keda',
    version: '2.15.1',
    namespace: kedaNamespace.metadata.name,
    repositoryOpts: {
      repo: 'https://kedacore.github.io/charts',
    },
    maxHistory: 1,
  },
  { provider },
)

// === EKS === Argo Workflow ===

// const argoNamespace = new k8s.core.v1.Namespace(nm('argo'), { metadata: { name: 'argo' } }, { provider })
// const argo = new k8s.helm.v3.Release(
//   nm('argo'),
//   {
//     name: 'argo',
//     chart: 'argo-workflows',
//     version: '0.42.1',
//     namespace: argoNamespace.metadata.name,
//     repositoryOpts: {
//       repo: 'https://argoproj.github.io/argo-helm',
//     },
//     maxHistory: 1,
//     values: {
//       server: {
//         ingress: {
//           enabled: true,
//           annotations: {
//             'cert-manager.io/cluster-issuer': 'letsencrypt-prod-issuer',
//           },
//           hosts: [config.argoWorkflows.host],
//           paths: ['/'],
//           pathType: 'Prefix',
//           tls: [
//             {
//               secretName: 'argo-workflows-tls',
//               hosts: [config.argoWorkflows.host],
//             },
//           ],
//         },
//       },
//       workflow: {
//         serviceAccount: {
//           create: true,
//           name: 'argo-workflow',
//         },
//         rbac: {
//           create: true,
//         },
//       },
//       singleNamespace: true,
//     },
//   },
//   { provider },
// )

// === EKS === ArgoCD ===

const argocdPassword = new random.RandomPassword(nm('argocd-password'), {
  length: 32,
  special: true,
})
const argocdNamespace = new k8s.core.v1.Namespace(nm('argocd'), { metadata: { name: 'argocd' } }, { provider })
const argocd = new k8s.helm.v3.Release(
  nm('argocd'),
  {
    name: 'argocd',
    chart: 'argo-cd',
    namespace: argocdNamespace.metadata.name,
    version: '8.1.2',
    maxHistory: 1,
    repositoryOpts: {
      repo: 'https://argoproj.github.io/argo-helm',
    },
    values: {
      configs: {
        params: {
          ['server.insecure']: true,
        },
        secret: {
          argocdServerAdminPassword: argocdPassword.bcryptHash,
        },
      },
      global: {
        domain: config.argocd.host,
      },
      server: {
        ingress: {
          enabled: true,
          annotations: {
            'cert-manager.io/cluster-issuer': 'letsencrypt-prod-issuer',
          },
          tls: true,
        },
      },
      controller: {
        metrics: {
          enabled: true,
        },
      },
      dex: {
        enabled: false,
      },
      notifications: {
        enabled: false,
      },
    },
  },
  { provider },
)

// === EKS === ArgoCD === Bootstrap ===

new k8s.apiextensions.CustomResource(
  nm('project'),
  {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'AppProject',
    metadata: {
      name: project,
      namespace: argocd.namespace,
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      sourceRepos: ['*'],
      destinations: [
        {
          namespace: '*',
          server: 'https://kubernetes.default.svc',
        },
      ],
      clusterResourceWhitelist: [
        {
          group: '*',
          kind: '*',
        },
      ],
    },
  },
  { provider },
)

function registerHelmRelease(release: k8s.helm.v3.Release, project: string) {
  release.name.apply((name) => {
    const {
      namespace,
      version: targetRevision,
      chart: chartId,
      values,
      repositoryOpts: { repo },
    } = release

    const { repoURL, chartName: chart } = chartId.apply((chartId) => {
      if (!chartId.startsWith('oci://'))
        return {
          repoURL: repo,
          chartName: chartId,
        }

      const withoutPrefix = chartId.replace('oci://', '')
      const parts = withoutPrefix.split('/')

      return {
        repoURL: parts.slice(0, -1).join('/'),
        chartName: parts.slice(-1)[0],
      }
    })

    new k8s.apiextensions.CustomResource(
      nm(name),
      {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: {
          name,
          namespace: argocd.namespace,
          annotations: {
            'argocd.argoproj.io/compare-options': 'ServerSideDiff=true,IncludeMutationWebhook=true',
          },
          // no finalizers, only pulumi will manage deletion
        },
        spec: {
          project,
          source: {
            repoURL,
            chart,
            targetRevision,
            helm: {
              values: pulumi.jsonStringify(values),
            },
          },
          destination: {
            server: 'https://kubernetes.default.svc',
            namespace,
          },
          syncPolicy: {
            automated: {
              selfHeal: true,
              prune: true,
            },
            syncOptions: ['PruneLast=true', 'ApplyOutOfSyncOnly=true', 'ServerSideApply=true'],
          },
        },
      },
      { provider },
    )
  })
}
;[
  karpenterCRD,
  karpenter,
  externalDNS,
  certManager,
  awsLoadBalancerController,
  metricsServer,
  // kubePrometheusStack,
  // loki,
  // promtail,
  eso,
  vpa,
  kyverno,
  velero,
  keda,
  // argo,
  // argocd,
  // TODO: configure argocd to play nicely with cilium
  // NOTE: https://docs.cilium.io/en/latest/configuration/argocd-issues/
  cilium,
].forEach((release) => registerHelmRelease(release, project))

// === Exports ===

// TODO: organize exports

export const clusterSecretStores = {
  aws: clusterSecretStoreAWS,
}
export const clusterIssuers = {
  letsencryptProd: letsencryptProdIssuerName,
  letsencryptStaging: letsencryptStagingIssuerName,
  zerosslProd: zerosslProdIssuerName,
}
export { kubeconfig, publicRouteTable, privateRouteTable, vpc, eksCluster, kmsKey, argocdPassword, grafanaPassword }
