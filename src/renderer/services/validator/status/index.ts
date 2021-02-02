import {BLSPubkey} from "@chainsafe/lodestar-types";
import {warn} from "electron-log";
import {IEth1Client} from "../../deposit/ethers";
import {ICgEth2ApiClient} from "../../eth2/client/interface";
import {ValidatorStatus} from "./statuses";

export * from "./statuses";

export async function getValidatorStatus(
    validatorPubKey: BLSPubkey,
    eth2Api: ICgEth2ApiClient,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    eth1Api: IEth1Client,
): Promise<ValidatorStatus> {
    if (!(await isBeaconNodeWorking(eth2Api))) {
        return ValidatorStatus.BEACON_ERROR;
    }
    if (!(await hasChainStarted(eth2Api))) {
        return ValidatorStatus.WAITING_START;
    }
    if (await isBeaconNodeSyncing(eth2Api)) {
        return ValidatorStatus.SYNCING;
    }
    return (undefined as unknown) as ValidatorStatus;
}

async function isBeaconNodeWorking(eth2Api: ICgEth2ApiClient | null): Promise<boolean> {
    if (!eth2Api) return false;
    try {
        return true;
        // eslint-disable-next-line no-unreachable
    } catch (e) {
        return false;
    }
}

async function hasChainStarted(eth2Api: ICgEth2ApiClient): Promise<boolean> {
    try {
        return !!(await eth2Api.beacon.getGenesis())?.genesisTime;
    } catch (e) {
        warn("Failed to get genesis time", e);
        return false;
    }
}

async function isBeaconNodeSyncing(eth2Api: ICgEth2ApiClient): Promise<boolean> {
    try {
        return (await eth2Api.node.getSyncingStatus()).syncDistance === BigInt(0);
    } catch (e) {
        warn("Failed to get syncing status", e);
        return true;
    }
}
