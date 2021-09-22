import {
    all,
    call,
    CallEffect,
    cancel,
    put,
    PutEffect,
    race,
    RaceEffect,
    retry,
    select,
    SelectEffect,
    spawn,
    take,
    TakeEffect,
    takeEvery,
} from "redux-saga/effects";
import {liveProcesses} from "../../services/utils/cmd";
import {
    cancelDockerPull,
    checkDockerDemonIsOnline,
    endDockerImagePull,
    setDockerDemonIsOffline,
    startDockerImagePull,
} from "../network/actions";
import {
    addBeacon,
    addBeacons,
    removeBeacon,
    startLocalBeacon,
    updateEpoch,
    updateSlot,
    updateStatus,
    updateVersion,
} from "./actions";
import {BeaconChain} from "../../services/docker/chain";
import {SupportedNetworks} from "../../services/eth2/supportedNetworks";
import database from "../../services/db/api/database";
import {Beacons} from "../../models/beacons";
import {postInit} from "../store";
import {Beacon, BeaconStatus} from "./slice";
import {Action} from "redux";
import {mainnetConfig} from "@chainsafe/lodestar-config/lib/presets/mainnet";
import {BeaconEventType, HeadEvent} from "@chainsafe/lodestar-validator/lib/api/interface/events";
import {AllEffect, CancelEffect, ForkEffect} from "@redux-saga/core/effects";
import {INetworkConfig} from "../../services/interfaces";
import {CGBeaconEvent, CGBeaconEventType, ErrorEvent} from "../../services/eth2/client/interface";
import {getBeaconByKey} from "./selectors";
import {SyncingStatus} from "@chainsafe/lodestar-types";
import {BeaconValidators, getValidatorsByBeaconNode} from "../validator/selectors";
import {getNewValidatorBalance, setValidatorStatus, storeValidatorBeaconNodes} from "../validator/actions";
import {ValidatorBeaconNodes} from "../../models/validatorBeaconNodes";
import {createNotification} from "../notification/actions";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {ValidatorStatus} from "../../constants/validatorStatus";
import {cgLogger, createLogger, getBeaconLogfileFromURL, mainLogger} from "../../../main/logger";
import {setInitialBeacons} from "../settings/actions";
import {DockerRegistry} from "../../services/docker/docker-registry";
import {
    CgEth2ApiClient,
    getBeaconNodeEth2ApiClient,
    getBeaconNodeVersion,
    readBeaconChainNetwork,
} from "../../services/eth2/client/module";
import {getClientParams} from "../../services/docker/getClientParams";
import {getWeakSubjectivityCheckpoint} from "./getWeakSubjectivityCheckpoint";

export function* pullDockerImage(
    image: string,
): Generator<PutEffect | RaceEffect<CallEffect | TakeEffect>, boolean, [boolean, Action]> {
    yield put(startDockerImagePull());
    cgLogger.info("Start beacon node image pull");
    try {
        cgLogger.info("image:", image);
        const [pullSuccess, effect] = yield race([call(BeaconChain.pullImage, image), take(cancelDockerPull)]);
        if (effect) {
            liveProcesses["pullImage"].kill();
        }
        yield put(endDockerImagePull());

        return effect !== undefined ? false : pullSuccess;
    } catch (e) {
        if (e.stderr) {
            const message = e.stderr.includes("daemon is not running")
                ? "Seems Docker is offline, start it and try again"
                : "Error while pulling Docker image, try again later";
            yield put(createNotification({title: message, source: "pullDockerImage"}));
            cgLogger.error(e.stderr);
        } else {
            yield put(createNotification({title: e.message, source: "pullDockerImage"}));
            mainLogger.error(e.message);
        }
        yield put(endDockerImagePull());
        return false;
    }
}

function* startLocalBeaconSaga({
    payload: {
        network,
        client,
        chainDataDir,
        eth1Url,
        discoveryPort,
        libp2pPort,
        rpcPort,
        memory,
        image,
        weakSubjectivityCheckpoint,
        weakSubjectivityCheckpointMeta,
    },
    meta: {onComplete},
}: ReturnType<typeof startLocalBeacon>): Generator<CallEffect | PutEffect, void, BeaconChain & string> {
    const pullSuccess = yield call(pullDockerImage, image);

    const ports = [
        {local: String(libp2pPort), host: String(libp2pPort)},
        {local: String(rpcPort), host: String(rpcPort)},
    ];
    if (libp2pPort !== discoveryPort) {
        ports.push({local: String(discoveryPort), host: String(discoveryPort)});
    }

    const wsc = yield call(
        getWeakSubjectivityCheckpoint,
        weakSubjectivityCheckpoint,
        weakSubjectivityCheckpointMeta,
        network,
    );

    cgLogger.info("Starting local docker beacon node & http://localhost:", rpcPort);
    if (pullSuccess) {
        yield put(
            addBeacon(`http://localhost:${rpcPort}`, network, {
                id: (yield call(BeaconChain.startBeaconChain, SupportedNetworks.LOCALHOST, {
                    ...getClientParams({
                        network,
                        libp2pPort,
                        discoveryPort,
                        rpcPort,
                        client,
                        eth1Url,
                        chainDataDir,
                        wsc,
                    }),
                    memory,
                    ports,
                    image,
                })).getParams().name,
                network,
                chainDataDir,
                eth1Url,
                discoveryPort,
                libp2pPort,
                rpcPort,
            }),
        );
        onComplete();
    }
}

function* storeBeacon({payload: {url, docker}}: ReturnType<typeof addBeacon>): Generator<Promise<void> | ForkEffect> {
    if (!docker)
        // eslint-disable-next-line no-param-reassign
        docker = {id: "", network: "", chainDataDir: "", eth1Url: "", discoveryPort: "", libp2pPort: "", rpcPort: ""};
    yield database.beacons.upsert({url, docker});
    yield spawn(watchOnHead, url);
}

function* removeBeaconSaga({
    payload,
}: ReturnType<typeof removeBeacon>): Generator<
    SelectEffect | PutEffect | Promise<[boolean, boolean]> | Promise<ValidatorBeaconNodes> | Promise<void>,
    void,
    [boolean, boolean] & BeaconValidators & ValidatorBeaconNodes
> {
    const [removed] = yield database.beacons.remove(payload);
    yield database.networkMetrics.delete(payload);
    if (removed) {
        const beaconValidators = yield select(getValidatorsByBeaconNode);
        if (beaconValidators[payload]?.length) {
            for (const {publicKey} of beaconValidators[payload]) {
                const {nodes} = yield database.validator.beaconNodes.remove(publicKey, payload);
                yield put(storeValidatorBeaconNodes(nodes, publicKey));
                if (!nodes.length) {
                    yield put(setValidatorStatus(ValidatorStatus.NO_BEACON_NODE, publicKey));
                }
            }
        }
    }
}

const getBeaconStatus = async (url: string): Promise<{syncing: boolean; slot: number} | null> => {
    try {
        const client = new CgEth2ApiClient(mainnetConfig, url);
        const result = await client.node.getSyncingStatus();
        return {slot: Number(result.headSlot), syncing: result.syncDistance > 10};
    } catch {
        return null;
    }
};

function* initializeBeaconsFromStore(): Generator<
    | Promise<Beacons>
    | PutEffect
    | Promise<void>
    | Promise<boolean>
    | AllEffect<CallEffect>
    | AllEffect<ForkEffect>
    | AllEffect<INetworkConfig>
    | TakeEffect,
    void,
    Beacons & ({syncing: boolean; slot: number} | null)[] & boolean & INetworkConfig[] & string[]
> {
    const store = yield database.beacons.get();
    if (store !== null) {
        const {beacons}: Beacons = store;
        cgLogger.info("Found", beacons.length, "beacon node/s");

        if (beacons.some(({docker}) => docker.id)) {
            if (!(yield BeaconChain.isDockerDemonRunning())) {
                yield put(setDockerDemonIsOffline(true));
                yield put(setInitialBeacons(false));
                while (true) {
                    yield take(checkDockerDemonIsOnline);
                    if (yield BeaconChain.isDockerDemonRunning()) {
                        yield put(setDockerDemonIsOffline(false));
                        yield put(setInitialBeacons(true));
                        break;
                    }
                }
            }
            yield BeaconChain.startAllLocalBeaconNodes();
        }

        const stats = yield all(beacons.map(({url}) => call(getBeaconStatus, url)));
        const networks = yield all(beacons.map(({url}) => call(readBeaconChainNetwork, url)));
        const versions = yield all(beacons.map(({url}) => call(getBeaconNodeVersion, url)));

        yield all(beacons.map(({url}) => spawn(watchOnHead, url)));

        yield put(
            addBeacons(
                beacons.map(({url, docker}, index) => ({
                    url,
                    network: networks[index]?.networkName || "Unknown",
                    docker: docker.id !== "" ? docker : undefined,
                    slot: stats[index]?.slot || 0,
                    version: versions[index],
                    status:
                        stats[index] !== null
                            ? stats[index].syncing
                                ? BeaconStatus.syncing
                                : BeaconStatus.active
                            : BeaconStatus.offline,
                })),
            ),
        );
    } else cgLogger.info("No beacon node found");
    yield put(setInitialBeacons(false));
}

export function* watchOnHead(
    url: string,
): Generator<
    | PutEffect
    | CancelEffect
    | RaceEffect<Promise<IteratorResult<CGBeaconEvent | ErrorEvent>> | TakeEffect>
    | CallEffect
    | SelectEffect
    | Promise<SyncingStatus>
    | Promise<boolean>,
    void,
    [IteratorResult<HeadEvent | ErrorEvent>, ReturnType<typeof removeBeacon>] &
        (INetworkConfig | null) &
        Beacon &
        SyncingStatus &
        typeof CgEth2ApiClient &
        boolean
> {
    const config = yield retry(30, 1000, readBeaconChainNetwork, url, true);
    const ApiClient: typeof CgEth2ApiClient = yield call(getBeaconNodeEth2ApiClient, url);
    const client = new ApiClient(config?.eth2Config || mainnetConfig, url);
    const eventStream = client.events.getEventStream([BeaconEventType.HEAD]);

    const beacon = yield select(getBeaconByKey, {key: url});
    let isSyncing =
        beacon.status === BeaconStatus.syncing ||
        beacon.status === BeaconStatus.offline ||
        beacon.status === BeaconStatus.starting;
    let isOnline = beacon.status !== BeaconStatus.offline;
    let epoch: number | undefined;
    let isStarting = beacon.status === BeaconStatus.starting;
    // fail safe in case of unexpected situation
    setTimeout(() => {
        isStarting = false;
    }, 30 * 1000);

    if (!beacon.version) {
        const version = ((yield call(getBeaconNodeVersion, beacon.url)) as unknown) as string;
        yield put(updateVersion(version, beacon.url));
    }

    cgLogger.info("Watching beacon on URL", url);
    const beaconLogger = createLogger(url, getBeaconLogfileFromURL(url));
    while (true) {
        try {
            const [payload, cancelAction] = yield race([
                eventStream[Symbol.asyncIterator]().next(),
                take(removeBeacon),
            ]);
            if (cancelAction || payload.done) {
                if (cancelAction.payload === url) {
                    cgLogger.info("Stopping beacon watching on", url);
                    eventStream.stop();
                    yield cancel();
                }
                continue;
            }
            if (payload.value.type === CGBeaconEventType.ERROR) {
                const isRunning = beacon.docker?.id
                    ? yield DockerRegistry.getContainer(beacon.docker?.id).isRunning()
                    : true;
                if (isOnline && !isStarting) {
                    yield put(updateStatus(BeaconStatus.offline, url));
                    isOnline = false;
                } else if (isRunning && !isStarting && beacon.docker?.id) {
                    isStarting = true;
                    yield put(updateStatus(BeaconStatus.starting, url));
                }
                continue;
            }
            yield put(updateSlot(payload.value.message.slot, url));
            if (isSyncing || !isOnline) {
                const result = yield client.node.getSyncingStatus();
                isSyncing = result.syncDistance > 10;
                isOnline = true;
                isStarting = false;
                yield put(updateStatus(isSyncing ? BeaconStatus.syncing : BeaconStatus.active, url));
                if (beacon.docker?.id) DockerRegistry.getContainer(beacon.docker?.id).startDockerLogger();
            }
            beaconLogger.info("Beacon on slot:", payload.value.message.slot);
            const headEpoch = computeEpochAtSlot(config?.eth2Config || mainnetConfig, payload.value.message.slot);
            if (epoch !== headEpoch) {
                beaconLogger.info("Beacon on epoch:", headEpoch);
                epoch = headEpoch;
                yield put(getNewValidatorBalance(url, payload.value.message.slot, headEpoch));
                yield put(updateEpoch(headEpoch, url));
            }
        } catch (err) {
            beaconLogger.error("Event error:", err.message);
        }
    }
}

export function* beaconSagaWatcher(): Generator {
    yield all([
        takeEvery(startLocalBeacon, startLocalBeaconSaga),
        takeEvery(addBeacon, storeBeacon),
        takeEvery(removeBeacon, removeBeaconSaga),
        takeEvery(postInit, initializeBeaconsFromStore),
    ]);
}
