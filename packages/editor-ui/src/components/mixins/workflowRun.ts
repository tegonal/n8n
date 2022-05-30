import {
	IExecutionPushResponse,
	IExecutionResponse,
	IStartRunData,
} from '@/Interface';

import {
	INode,
	IRunData,
	IRunExecutionData,
	ITaskData,
	NodeHelpers,
	PinData,
	PinDataNode,
	Workflow,
} from 'n8n-workflow';

import { externalHooks } from '@/components/mixins/externalHooks';
import { restApi } from '@/components/mixins/restApi';
import { workflowHelpers } from '@/components/mixins/workflowHelpers';
import { showMessage } from '@/components/mixins/showMessage';

import mixins from 'vue-typed-mixins';
import { titleChange } from './titleChange';

export const workflowRun = mixins(
	externalHooks,
	restApi,
	workflowHelpers,
	showMessage,
	titleChange,
).extend({
	methods: {
		// Starts to executes a workflow on server.
		async runWorkflowApi (runData: IStartRunData): Promise<IExecutionPushResponse> {
			if (this.$store.getters.pushConnectionActive === false) {
				// Do not start if the connection to server is not active
				// because then it can not receive the data as it executes.
				throw new Error(
					this.$locale.baseText('workflowRun.noActiveConnectionToTheServer'),
				);
			}

			this.$store.commit('addActiveAction', 'workflowRunning');

			let response: IExecutionPushResponse;

			try {
				response = await this.restApi().runWorkflow(runData);
			} catch (error) {
				this.$store.commit('removeActiveAction', 'workflowRunning');
				throw error;
			}

			if (response.executionId !== undefined) {
				this.$store.commit('setActiveExecutionId', response.executionId);
			}

			if (response.waitingForWebhook === true) {
				this.$store.commit('setExecutionWaitingForWebhook', true);
			}

			return response;
		},

		getPinDataIndexes(nodeNames: string[]) {
			const workflow = this.getWorkflow();

			return nodeNames.reduce<number[]>((acc, name, index) => {
				if (workflow.nodes[name].pinData !== undefined) acc.push(index);
				return acc;
			}, []);
		},

		getPinDataNodes(workflow: Workflow): PinDataNode[] {
			return Object.values(workflow.nodes).filter(
				(node): node is PinDataNode => node.pinData !== undefined,
			);
		},

		toTaskData(pinData: PinData): ITaskData[] {
			return [
				{
					startTime: 0,
					executionTime: 0,
					data: { main: [ [ { json: pinData }] ] },
				},
			];
		},

		async runWorkflow (nodeName?: string, source?: string): Promise<IExecutionPushResponse | undefined> {
			const workflow = this.getWorkflow();

			if(nodeName) {
				this.$telemetry.track('User clicked execute node button', { node_type: nodeName, workflow_id: this.$store.getters.workflowId });
			} else {
				this.$telemetry.track('User clicked execute workflow button', { workflow_id: this.$store.getters.workflowId });
			}

			if (this.$store.getters.isActionActive('workflowRunning') === true) {
				return;
			}

			this.$titleSet(workflow.name as string, 'EXECUTING');

			this.clearAllStickyNotifications();

			try {
				// Check first if the workflow has any issues before execute it
				const issuesExist = this.$store.getters.nodesIssuesExist;
				if (issuesExist === true) {
					// If issues exist get all of the issues of all nodes
					const workflowIssues = this.checkReadyForExecution(workflow, nodeName);
					if (workflowIssues !== null) {
						const errorMessages = [];
						let nodeIssues: string[];
						for (const nodeName of Object.keys(workflowIssues)) {
							nodeIssues = NodeHelpers.nodeIssuesToString(workflowIssues[nodeName]);
							for (const nodeIssue of nodeIssues) {
								errorMessages.push(`${nodeName}: ${nodeIssue}`);
							}
						}

						this.$showMessage({
							title: this.$locale.baseText('workflowRun.showMessage.title'),
							message: this.$locale.baseText('workflowRun.showMessage.message') + ':<br />&nbsp;&nbsp;- ' + errorMessages.join('<br />&nbsp;&nbsp;- '),
							type: 'error',
							duration: 0,
						});
						this.$titleSet(workflow.name as string, 'ERROR');
						this.$externalHooks().run('workflowRun.runError', { errorMessages, nodeName });
						return;
					}
				}

				// Get the direct parents of the node
				let directParentNodes: string[] = [];
				if (nodeName !== undefined) {
					directParentNodes = workflow.getParentNodes(nodeName, 'main', 1);
				}

				const runData = this.$store.getters.getWorkflowRunData;

				let newRunData: IRunData | undefined = {};

				const startNodes: string[] = [];

				/**
				 * Collect all parents for the clicked node, i.e. all nodes leading up to
				 * the clicked node, from a single branch or multiple branches.
				 */
				const parentNodes = [
					...directParentNodes.flatMap(dpn => workflow.getParentNodes(dpn, 'main')),
					...directParentNodes,
				];

				/**
				 * For pin-data workflow, mark start nodes
				 *
				 * For every parent node immediately following a pin-data node,
				 * mark them as nodes to start the execution from.
				 *
				 * For any parent nodes preceding the earliest pin-data node,
				 * mark the first as a node to start the execution from.
				 */
				const pinDataIndexes = this.getPinDataIndexes(parentNodes);
				const workflowHasPinData = pinDataIndexes.length > 0;

				if (workflowHasPinData) {
					for (const index of pinDataIndexes) {
						startNodes.push(parentNodes[index + 1]);
					}

					const earliestPinDataIndex = Math.min(...pinDataIndexes);

					for (const [nodeIndex, nodeName] of parentNodes.entries()) {
						if (nodeIndex < earliestPinDataIndex) {
							startNodes.push(nodeName);
							break;
						}
					}
				}

				/**
				 * If the workflow contains pin data, assign pin data to pin-data nodes and leave
				 * non-pin-data nodes empty. Run data is not used in a workflow containing pin data.
				 *
				 * If the workflow contains no pin data, assign run data to run data nodes, and
				 * mark the first non-run-data node as a node to start the execution from.
				 */
				for (const nodeName of parentNodes) {

					if (workflowHasPinData) {
						const node = workflow.nodes[nodeName];

						if (node.pinData) {
							console.log('Assigning pinData as runData for', nodeName);
							newRunData[nodeName] = this.toTaskData(node.pinData);
						} else {
							// @DELETE branch only for debug logging
							console.log('Skipping runData assignment for', nodeName);
						}
						continue;
					}

					if (!runData) continue;

					if (runData[nodeName] === undefined || runData[nodeName].length === 0) {
						// When we hit a node which has no data we stop and set it
						// as a start node the execution from and then go on with other
						// direct input nodes
						startNodes.push(nodeName);
						break;
					}

					if (runData[nodeName]) {
						console.log('Assigning runData for', nodeName);
						newRunData[nodeName] = runData[nodeName].slice(0, 1);
					}
				}

				/**
				 * If no start nodes and clicked node, mark clicked node as start node.
				 */
				if (startNodes.length === 0 && nodeName !== undefined) {
					startNodes.push(nodeName);
				}

				/**
				 * If no start nodes and no clicked node, populate run data with pin data.
				 */
				if (startNodes.length === 0 && nodeName === undefined) {
					for (const node of this.getPinDataNodes(workflow)) {
						newRunData[node.name] = this.toTaskData(node.pinData);
					}
				}

				/**
				 * If no run data was assigned for any of the parent nodes,
				 * clear it to ensure a full workflow execution.
				 */
				if (Object.keys(newRunData).length === 0) {
					newRunData = undefined;
				}

				const isNewWorkflow = this.$store.getters.isNewWorkflow;
				const hasWebhookNode = this.$store.getters.currentWorkflowHasWebhookNode;
				if (isNewWorkflow && hasWebhookNode) {
					await this.saveCurrentWorkflow();
				}

				const workflowData = await this.getWorkflowDataToSave();

				const startRunData: IStartRunData = {
					workflowData,
					runData: newRunData,
					startNodes,
				};
				if (nodeName) {
					startRunData.destinationNode = nodeName;
				}

				// Init the execution data to represent the start of the execution
				// that data which gets reused is already set and data of newly executed
				// nodes can be added as it gets pushed in
				const executionData: IExecutionResponse = {
					id: '__IN_PROGRESS__',
					finished: false,
					mode: 'manual',
					startedAt: new Date(),
					stoppedAt: undefined,
					workflowId: workflow.id,
					executedNode: nodeName,
					data: {
						resultData: {
							runData: newRunData || {},
							startNodes,
							workflowData,
						},
					} as IRunExecutionData,
					workflowData: {
						id: this.$store.getters.workflowId,
						name: workflowData.name!,
						active: workflowData.active!,
						createdAt: 0,
						updatedAt: 0,
						...workflowData,
					},
				};
				this.$store.commit('setWorkflowExecutionData', executionData);
				this.updateNodesExecutionIssues();

				 const runWorkflowApiResponse = await this.runWorkflowApi(startRunData);

				 this.$externalHooks().run('workflowRun.runWorkflow', { nodeName, source });

				 return runWorkflowApiResponse;
			} catch (error) {
				this.$titleSet(workflow.name as string, 'ERROR');
				this.$showError(
					error,
					this.$locale.baseText('workflowRun.showError.title'),
				);
				return undefined;
			}
		},
	},
});
