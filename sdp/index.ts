import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import * as eks from '@pulumi/eks'
import * as k8s from '@pulumi/kubernetes'
import { registerAutoTags } from './utils/autotag.ts'

const project = pulumi.getProject()
const stack = pulumi.getStack()

// Automatically inject tags.
registerAutoTags({
	'pulumi:Project': project,
	'pulumi:Stack': stack,
})

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

// === EKS === Node Role ===

const eksNodeRoleName = nm('node-role')
const eksNodeRole = new aws.iam.Role(eksNodeRoleName, {
	assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
		Service: 'ec2.amazonaws.com',
	}),
	path: '/',
	managedPolicyArns: [
		'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
		'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
		'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
		'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
	],
})

// === EKS === Cluster ===

const eksClusterName = nm('eks')
const {
	provider,
	eksCluster,
	core: cluster,
	kubeconfigJson,
} = new eks.Cluster(eksClusterName, {
	name: eksClusterName,
	version: '1.29',
	vpcId: vpc.id,
	createOidcProvider: true,
	publicSubnetIds: publicSubnets.map((s) => s.id),
	privateSubnetIds: privateSubnets.map((s) => s.id),
	nodeAssociatePublicIpAddress: false,
	encryptionConfigKeyArn: kmsKey.arn,
	defaultAddonsToRemove: ['kube-proxy'],
	skipDefaultNodeGroup: true,
	vpcCniOptions: {
		enablePrefixDelegation: true,
	},
	nodeGroupOptions: {
		taints: {
			'node.cilium.io/agent-not-ready': {
				value: 'true',
				effect: 'NoExecute',
			},
		},
	},
	roleMappings: [
		{
			roleArn: eksNodeRole.arn,
			username: 'system:node:{{EC2PrivateDNSName}}',
			groups: ['system:bootstrappers', 'system:nodes'],
		},
	],
})

privateSubnets.map((subnet) => {
	subnet.id.apply((subnetId) => {
		new aws.ec2.Tag(nm(`${subnetId}-tag`), {
			key: 'karpenter.sh/discovery',
			value: eksCluster.name,
			resourceId: subnetId,
		})
	})
})

// === EKS === Node Group ===

const highPriorityNodeGroupName = nm('high-priority')
new eks.ManagedNodeGroup(highPriorityNodeGroupName, {
	nodeGroupName: highPriorityNodeGroupName,
	cluster,
	instanceTypes: ['m7g.medium', 't4g.medium'],
	capacityType: 'SPOT',
	amiType: 'BOTTLEROCKET_ARM_64',
	// amiType: 'AL2023_ARM_64_STANDARD',
	nodeRole: cluster.instanceRoles[0],
	scalingConfig: {
		minSize: 3,
		maxSize: 3,
		desiredSize: 3,
	},
})

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
	resolveConflictsOnCreate: 'OVERWRITE',
})

// === EKS === Addons === VPC CNI ===

const vpcCniAddon = new aws.eks.Addon(nm('vpc-cni'), {
	addonName: 'vpc-cni',
	clusterName: eksCluster.name,
	addonVersion: eksCluster.version.apply(
		async (kubernetesVersion) =>
			await aws.eks.getAddonVersion({
				addonName: 'vpc-cni',
				kubernetesVersion,
				mostRecent: true,
			}),
	).version,
	resolveConflictsOnCreate: 'OVERWRITE',
})
new k8s.apps.v1.DaemonSetPatch(
	nm('aws-node-daemonset'),
	{
		metadata: {
			namespace: 'kube-system',
			name: 'aws-node',
		},
		spec: {
			template: {
				spec: {
					nodeSelector: {
						'io.cilium/aws-node-enabled': 'true',
					},
				},
			},
		},
	},
	{ provider, retainOnDelete: true, dependsOn: vpcCniAddon },
)

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
	resolveConflictsOnCreate: 'OVERWRITE',
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
	resolveConflictsOnCreate: 'OVERWRITE',
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
				loadbalancerMode: 'dedicated',
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
				actions: [
					'iam:AddRoleToInstanceProfile',
					'iam:RemoveRoleFromInstanceProfile',
					'iam:DeleteInstanceProfile',
				],
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
	policy: pulumi.all([eksCluster.name, EC2InterruptionQueue.name, eksNodeRole.name]).apply(
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
	assumeRolePolicy: {
		Version: '2012-10-17',
		Statement: [
			{
				Action: ['sts:AssumeRole', 'sts:TagSession'],
				Effect: 'Allow',
				Principal: {
					Service: 'pods.eks.amazonaws.com',
				},
			},
		],
	},
})
new aws.iam.RolePolicyAttachment(karpenterControllerRoleName, {
	policyArn: KarpenterControllerPolicy.arn,
	role: karpenterControllerRole,
})

new aws.eks.PodIdentityAssociation(nm('pod-identity-association'), {
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
			role: eksNodeRole.name,
			associatePublicIPAddress: false,
			subnetSelectorTerms: [
				{
					tags: {
						'karpenter.sh/discovery': eksCluster.name,
					},
				},
			],
			securityGroupSelectorTerms: [
				{
					tags: {
						'aws:eks:cluster-name': eksCluster.name,
					},
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
					// https://github.com/bottlerocket-os/bottlerocket/issues/1721
					// kubelet: {
					//   podsPerCore: 20,
					//   maxPods: 110
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

new k8s.helm.v3.Release(
	nm('argocd'),
	{
		name: 'argocd',
		chart: 'argo-cd',
		namespace: 'argocd',
		repositoryOpts: {
			repo: 'https://argoproj.github.io/argo-helm',
		},
		values: {
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
	},
	{ provider },
)

export const kubeconfig = kubeconfigJson
