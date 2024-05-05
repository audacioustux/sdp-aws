import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import { registerAutoTags } from './utils/autotag.ts'
import * as config from './config.ts'
import { assumeRoleForEKSPodIdentity } from './utils/policyStatement.ts'
import { AppProject, Application } from './crds/argocd.ts'

// Automatically inject tags.
registerAutoTags({
  'pulumi:Organization': config.pulumi.organization,
  'pulumi:Project': config.pulumi.project,
  'pulumi:Stack': config.pulumi.stack,
})

const nm = (name: string) => `${config.pulumi.project}-${config.pulumi.stack}-${name}`

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

const availabilityZones = await aws.getAvailabilityZones({
  state: 'available',
})
const publicSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = nm(`public-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: true,
    tags: {
      Name: subnetName,
    },
  })
})
const privateSubnets = availabilityZones.names.map((az, index) => {
  const subnetName = nm(`private-${index}`)
  return new aws.ec2.Subnet(subnetName, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${index + 10}.0/24`,
    availabilityZone: az,
    mapPublicIpOnLaunch: false,
    tags: {
      Name: subnetName,
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
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      gatewayId: internetGateway.id,
    },
  ],
  tags: {
    Name: publicRouteTableName,
  },
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
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      natGatewayId: natGateway.id,
    },
  ],
  tags: {
    Name: privateRouteTableName,
  },
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

const eksInstanceRole = new aws.iam.Role(nm('eks-instance-role'), {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
  managedPolicyArns: [
    'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
    'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
    'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  ],
})

const eksClusterName = nm('eks')
const {
  eksCluster,
  core: cluster,
  kubeconfig,
  provider,
} = new eks.Cluster(eksClusterName, {
  name: eksClusterName,
  version: '1.29',
  vpcId: vpc.id,
  createOidcProvider: true,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  privateSubnetIds: privateSubnets.map((s) => s.id),
  nodeAssociatePublicIpAddress: false,
  encryptionConfigKeyArn: kmsKey.arn,
  defaultAddonsToRemove: ['kube-proxy', 'vpc-cni', 'coredns'],
  useDefaultVpcCni: true,
  skipDefaultNodeGroup: true,
  // TODO: disable public access to the cluster (use vpc client endpoint instead)
  // endpointPublicAccess: false,
  nodeGroupOptions: {
    taints: {
      'node.cilium.io/agent-not-ready': {
        value: 'true',
        effect: 'NoExecute',
      },
    },
  },
  instanceRole: eksInstanceRole,
})

const clusterSecurityGroupId = eksCluster.vpcConfig.clusterSecurityGroupId

// === EKS === Node Group ===

const highPriorityNodeGroupName = nm('high-priority')
new eks.ManagedNodeGroup(highPriorityNodeGroupName, {
  nodeGroupName: highPriorityNodeGroupName,
  cluster,
  instanceTypes: ['m7g.large', 't4g.large'],
  capacityType: 'SPOT',
  amiType: 'BOTTLEROCKET_ARM_64',
  // amiType: 'AL2023_ARM_64_STANDARD',
  nodeRole: cluster.instanceRoles[0],
  scalingConfig: {
    minSize: 2,
    maxSize: 2,
    desiredSize: 2,
  },
})

// === EKS === Cilium ===

const k8sServiceHosts = k8s.core.v1.Endpoints.get('kubernetes-endpoint', 'kubernetes', { provider }).subsets.apply(
  (subsets) => subsets.map((subset) => subset.addresses.map((address) => address.ip)).flat(),
)
new k8s.helm.v3.Release(
  nm('cilium'),
  {
    name: 'cilium',
    chart: 'cilium',
    namespace: 'kube-system',
    repositoryOpts: {
      repo: 'https://helm.cilium.io',
    },
    values: {
      kubeProxyReplacement: 'strict',
      k8sServiceHost: k8sServiceHosts[0],
      ingressController: {
        enabled: true,
        loadbalancerMode: 'shared',
        default: true,
      },
      hubble: {
        relay: {
          enabled: true,
        },
        ui: {
          enabled: true,
        },
      },
      loadBalancer: {
        algorithm: 'maglev',
        l7: {
          backend: 'envoy',
        },
      },
      envoy: {
        enabled: true,
      },
      routingMode: 'native',
      bpf: {
        masquerade: true,
      },
      ipam: {
        mode: 'eni',
      },
      eni: {
        enabled: true,
        awsEnablePrefixDelegation: true,
      },
    },
  },
  { provider },
)

// === EKS === Addons === CoreDNS ===

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
})

// === EKS === Addons === EBS CSI Driver ===

const ebsCsiDriverRoleName = nm('ebs-csi-driver-irsa')
const ebsCsiDriverRole = new aws.iam.Role(ebsCsiDriverRoleName, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
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
})

// === EKS === Addons === CSI Snapshot Controller ===

new aws.eks.Addon(nm('csi-snapshot-controller'), {
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

const partitionId = await aws.getPartition().then((partition) => partition.id)
const regionId = await aws.getRegion().then((region) => region.id)
const accountId = await aws.getCallerIdentity().then((identity) => identity.accountId)

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

const karpenter = new k8s.helm.v3.Release(
  nm('karpenter'),
  {
    name: 'karpenter',
    chart: 'oci://public.ecr.aws/karpenter/karpenter',
    namespace: 'kube-system',
    values: {
      settings: {
        clusterName: eksCluster.name,
        interruptionQueue: EC2InterruptionQueue.name,
        featureGates: {
          spotToSpotConsolidation: true,
        },
      },
    },
    timeout: 60 * 30,
  },
  { provider },
)

// === EKS === Karpenter === Node Class ===

const defaultNodeClass = new k8s.apiextensions.CustomResource(
  nm('default-node-class'),
  {
    apiVersion: 'karpenter.k8s.aws/v1beta1',
    kind: 'EC2NodeClass',
    metadata: {
      name: 'default',
    },
    spec: {
      amiFamily: 'Bottlerocket',
      // amiFamily: 'AL2023',
      role: eksInstanceRole.name,
      associatePublicIPAddress: false,
      subnetSelectorTerms: privateSubnets.map((subnet) => ({
        id: subnet.id,
      })),
      securityGroupSelectorTerms: [
        {
          id: clusterSecurityGroupId,
        },
      ],
    },
  },
  { provider, dependsOn: [karpenter] },
)

// === EKS === Karpenter === Node Pool ===

new k8s.apiextensions.CustomResource(
  nm('default-node-pool'),
  {
    apiVersion: 'karpenter.sh/v1beta1',
    kind: 'NodePool',
    metadata: {
      name: 'default',
    },
    spec: {
      template: {
        spec: {
          requirements: [
            {
              key: 'kubernetes.io/arch',
              operator: 'In',
              values: ['arm64'],
            },
            {
              key: 'kubernetes.io/os',
              operator: 'In',
              values: ['linux'],
            },
            {
              key: 'karpenter.sh/capacity-type',
              operator: 'In',
              values: ['spot', 'on-demand'],
            },
          ],
          nodeClassRef: {
            apiVersion: 'karpenter.k8s.aws/v1beta1',
            kind: 'EC2NodeClass',
            name: defaultNodeClass.metadata.name,
          },
          // NOTE: https://github.com/bottlerocket-os/bottlerocket/issues/1721
          // TODO: enable this once pod right-sizing is implemented
          // kubelet: {
          //   podsPerCore: 20,
          //   maxPods: 110,
          // },
        },
      },
      limits: {
        cpu: '16',
        memory: '32Gi',
      },
      disruption: {
        consolidationPolicy: 'WhenUnderutilized',
        expireAfter: `${24 * 7}h`,
      },
    },
  },
  { provider, dependsOn: [karpenter] },
)

// === EKS === ArgoCD ===

const argocdRelease = new k8s.helm.v3.Release(
  nm('argocd'),
  {
    name: 'argocd',
    chart: 'argo-cd',
    namespace: 'argocd',
    repositoryOpts: {
      repo: 'https://argoproj.github.io/argo-helm',
    },
    values: {
      configs: {
        repositories: {
          sdp: {
            url: config.git.repo,
            username: config.git.username,
            password: config.git.password,
          },
        },
      },
      'redis-ha': {
        enabled: true,
      },
      controller: {
        replicas: 1,
      },
      server: {
        autoscaling: {
          enabled: true,
          minReplicas: 2,
        },
      },
      repoServer: {
        autoscaling: {
          enabled: true,
          minReplicas: 2,
        },
      },
      applicationSet: {
        replicas: 2,
      },
    },
    createNamespace: true,
    timeout: 60 * 30,
  },
  { provider },
)

const sdpProjectName = 'sdp'
new AppProject(
  nm(sdpProjectName),
  {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'AppProject',
    metadata: {
      namespace: 'argocd',
      name: sdpProjectName,
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      clusterResourceWhitelist: [
        {
          group: '*',
          kind: '*',
        },
      ],
      description: "Software Delivery Platform's project",
      destinations: [
        {
          namespace: '*',
          server: 'https://kubernetes.default.svc',
        },
      ],
      sourceRepos: ['*'],
    },
  },
  { provider },
)

// === EKS === External DNS === IAM ===

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
  namespace: 'kube-system',
  serviceAccount: 'external-dns',
  roleArn: externalDNSRole.arn,
})
new Application(
  nm('external-dns'),
  {
    metadata: {
      name: 'external-dns',
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: sdpProjectName,
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'kube-system',
      },
      source: {
        repoURL: 'https://kubernetes-sigs.github.io/external-dns',
        chart: 'external-dns',
        targetRevision: '*',
        helm: {
          values: pulumi.jsonStringify({
            serviceAccount: {
              create: true,
              name: 'external-dns',
            },
          }),
        },
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: ['ServerSideApply=true'],
      },
    },
  },
  { provider, dependsOn: [argocdRelease] },
)

// === EKS === Cert Manager ===

new Application(
  nm('cert-manager'),
  {
    metadata: {
      name: 'cert-manager',
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: sdpProjectName,
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'cert-manager',
      },
      source: {
        repoURL: 'https://charts.jetstack.io',
        chart: 'cert-manager',
        targetRevision: '*',
        helm: {
          values: pulumi.jsonStringify({
            installCRDs: true,
            prometheus: {
              enabled: true,
              servicemonitor: {
                enabled: true,
              },
            },
            enableCertificateOwnerRef: true,
            extraArgs: [
              '--enable-certificate-owner-ref=true',
              '--dns01-recursive-nameservers-only',
              '--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53',
            ],
            securityContext: {
              fsGroup: 1001,
            },
          }),
        },
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: ['ServerSideApply=true', 'CreateNamespace=true'],
      },
    },
  },
  { provider, dependsOn: [argocdRelease] },
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

// === EKS === Metrics Server ===

new Application(
  nm('metrics-server'),
  {
    metadata: {
      name: 'metrics-server',
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: sdpProjectName,
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'kube-system',
      },
      source: {
        repoURL: 'https://kubernetes-sigs.github.io/metrics-server/',
        chart: 'metrics-server',
        targetRevision: '*',
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: ['ServerSideApply=true'],
      },
    },
  },
  { provider, dependsOn: [argocdRelease] },
)

// === EKS === Kube Prometheus Stack ===

// NOTE: https://github.com/argoproj/argo-cd/issues/6880
new Application(
  nm('kube-prometheus-stack'),
  {
    metadata: {
      name: 'kube-prometheus-stack',
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: sdpProjectName,
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'kube-prometheus',
      },
      source: {
        repoURL: 'https://prometheus-community.github.io/helm-charts',
        chart: 'kube-prometheus-stack',
        targetRevision: '*',
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: ['ServerSideApply=true', 'CreateNamespace=true', 'PruneLast=true'],
      },
    },
  },
  { provider, dependsOn: [argocdRelease] },
)

// === EKS === External Secrets ===

new Application(
  nm('external-secrets'),
  {
    metadata: {
      name: 'external-secrets',
      namespace: 'argocd',
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: sdpProjectName,
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'kube-system',
      },
      source: {
        repoURL: 'https://charts.external-secrets.io',
        chart: 'external-secrets',
        targetRevision: '*',
        helm: {
          values: pulumi.jsonStringify({
            installCRDs: true,
          }),
        },
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
        syncOptions: ['ServerSideApply=true'],
      },
    },
  },
  { provider, dependsOn: [argocdRelease] },
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
  namespace: 'kube-system',
  serviceAccount: 'external-secrets',
  roleArn: esoSARole.arn,
})
new k8s.apiextensions.CustomResource(
  nm('aws-secrets-store'),
  {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ClusterSecretStore',
    metadata: {
      name: 'aws-secrets-store',
      namespace: 'kube-system',
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
  { provider },
)

export const eso = {
  clusterSecretStore: {
    aws: 'aws-secrets-store',
  },
}

// TODO: narrow down, or export all
export { kubeconfig, vpc, publicRouteTable, privateRouteTable, clusterSecurityGroupId }
