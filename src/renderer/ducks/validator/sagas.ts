import {
    select,
    put,
    SelectEffect,
    PutEffect,
    all,
    takeEvery,
    race,
    take,
    cancel,
    fork,
    RaceEffect,
    CancelEffect,
    TakeEffect,
    AllEffect,
    ForkEffect,
    CallEffect,
    call,
} from "redux-saga/effects";
import {CGAccount} from "../../models/account";
import {deleteKeystore} from "../../services/utils/account";
import {ValidatorLogger} from "../../services/eth2/client/logger";
import database, {cgDbController} from "../../services/db/api/database";
import {config as mainnetConfig} from "@chainsafe/lodestar-config/lib/presets/mainnet";
import {IValidator} from "./slice";
import {
    addNewValidator,
    addValidator,
    loadValidators,
    loadValidatorsAction,
    removeActiveValidator,
    removeValidator,
    setValidatorBeaconNode,
    startNewValidatorService,
    startValidatorService,
    stopActiveValidatorService,
    stopValidatorService,
    storeValidatorBeaconNodes,
    slashingProtectionUpload,
    slashingProtectionSkip,
    slashingProtectionCancel,
    updateValidatorBalance,
    setValidatorStatus,
    getNewValidatorBalance,
    signedNewAttestation,
} from "./actions";
import {ICGKeystore} from "../../services/keystore";
import {unsubscribeToBlockListening} from "../network/actions";
import {Validator} from "@chainsafe/lodestar-validator";
import {Genesis} from "@chainsafe/lodestar-types";
import * as logger from "electron-log";
import {getAuthAccount} from "../auth/selectors";
import {getValidator, getValidatorBeaconNodes} from "./selectors";
import {ValidatorBeaconNodes} from "../../models/validatorBeaconNodes";
import {CgEth2ApiClient} from "../../services/eth2/client/eth2ApiClient";
import {Beacon} from "../beacon/slice";
import {readBeaconChainNetwork} from "../../services/eth2/client";
import {INetworkConfig} from "../../services/interfaces";
import {getValidatorBalance} from "../../services/utils/validator";
import {getValidatorStatus} from "../../services/utils/getValidatorStatus";
import {CGSlashingProtection} from "../../services/eth2/client/slashingProtection";
import {readFileSync} from "fs";
import {ValidatorStatus} from "../../constants/validatorStatus";
import {getNetworkConfig} from "../../services/eth2/networks";
import {updateSlot} from "../beacon/actions";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";

interface IValidatorServices {
    [validatorAddress: string]: Validator;
}

const validatorServices: IValidatorServices = {};

function* loadValidatorsSaga(): Generator<
    | SelectEffect
    | PutEffect
    | Promise<ICGKeystore[]>
    | Promise<ValidatorBeaconNodes[]>
    | Promise<IValidator[]>
    | AllEffect<ForkEffect>
    | AllEffect<CallEffect>,
    void,
    ICGKeystore[] & (CGAccount | null) & ValidatorBeaconNodes[] & IValidator[]
> {
    const auth: CGAccount | null = yield select(getAuthAccount);
    if (auth) {
        const validators: ICGKeystore[] = yield auth.loadValidators();
        const validatorArray: IValidator[] = yield Promise.all(
            validators.map(async (keyStore, index) => {
                const beaconNodes = await database.validatorBeaconNodes.get(keyStore.getPublicKey());
                const network = auth.getValidatorNetwork(keyStore.getPublicKey());
                const balance = await getValidatorBalance(keyStore.getPublicKey(), network, beaconNodes?.nodes[0]);
                return {
                    name: keyStore.getName() ?? `Validator - ${index}`,
                    status: await getValidatorStatus(keyStore.getPublicKey(), beaconNodes?.nodes[0]),
                    publicKey: keyStore.getPublicKey(),
                    network,
                    balance,
                    keystore: keyStore,
                    isRunning: false,
                    beaconNodes: beaconNodes?.nodes || [],
                };
            }),
        );
        yield put(loadValidators(validatorArray));
        yield all(validatorArray.map(({publicKey, network}) => fork(validatorInfoUpdater, publicKey, network)));
    }
}

export function* addNewValidatorSaga(action: ReturnType<typeof addNewValidator>): Generator<PutEffect | ForkEffect> {
    const keystore = action.meta.loadKeystore(action.payload.publicKey);
    const validator: IValidator = {
        name: action.payload.name || `Validator ${action.meta.getValidators().length + 2}`,
        publicKey: action.payload.publicKey,
        network: action.meta!.getValidatorNetwork(action.payload.publicKey),
        keystore,
        status: undefined,
        isRunning: false,
        beaconNodes: [],
    };

    yield put(addValidator(validator));
    yield fork(validatorInfoUpdater, validator.publicKey, validator.network);
}

function* removeValidatorSaga(
    action: ReturnType<typeof removeActiveValidator>,
): Generator<SelectEffect | PutEffect, void, CGAccount | null> {
    const auth: CGAccount | null = yield select(getAuthAccount);
    deleteKeystore(auth.directory, action.payload);
    auth.removeValidator(action.meta);

    yield put(unsubscribeToBlockListening(action.payload));
    yield put(removeValidator(action.payload));
}

function* startService(
    action: ReturnType<typeof startNewValidatorService>,
): Generator<
    | SelectEffect
    | PutEffect
    | Promise<void>
    | Promise<boolean>
    | Promise<INetworkConfig | null>
    | Promise<Genesis | null>
    | RaceEffect<TakeEffect>,
    void,
    Beacon[] & (INetworkConfig | null) & (Genesis | null) & boolean
> {
    try {
        const publicKey = action.payload.publicKey.toHex();
        const beaconNodes = yield select(getValidatorBeaconNodes, {publicKey});
        if (!beaconNodes.length) {
            throw new Error("missing beacon node");
        }

        const config = (yield readBeaconChainNetwork(beaconNodes[0].url))?.eth2Config || mainnetConfig;

        // TODO: Use beacon chain proxy instead of first node
        const eth2API = new CgEth2ApiClient(config, beaconNodes[0].url, publicKey);

        const slashingProtection = new CGSlashingProtection({
            config,
            controller: cgDbController,
        });

        // TODO: check if state is not before "active" to ignore this step in that case
        if (yield slashingProtection.missingImportedSlashingProtection(publicKey)) {
            action.meta.openModal();
            const [upload, cancel] = yield race([
                take(slashingProtectionUpload),
                take(slashingProtectionCancel),
                take(slashingProtectionSkip),
            ]);
            action.meta.closeModal();

            if (cancel) {
                throw new Error("canceled by user");
            }
            if (upload) {
                const {genesisValidatorsRoot} = yield eth2API.beacon.getGenesis();
                const interchange = JSON.parse(
                    readFileSync(
                        ((upload as unknown) as ReturnType<typeof slashingProtectionUpload>).payload,
                    ).toString(),
                );
                yield slashingProtection.importInterchange(interchange, genesisValidatorsRoot);
            }
        }

        const logger = new ValidatorLogger();

        if (!validatorServices[publicKey]) {
            validatorServices[publicKey] = new Validator({
                slashingProtection,
                api: eth2API,
                config,
                secretKeys: [action.payload.privateKey],
                logger,
                graffiti: "ChainGuardian",
            });
        }
        yield validatorServices[publicKey].start();

        yield put(startValidatorService(logger, publicKey));
    } catch (e) {
        logger.error("Failed to start validator", e.message);
    }
}

function* stopService(action: ReturnType<typeof stopActiveValidatorService>): Generator<PutEffect | Promise<void>> {
    const publicKey = action.payload.publicKey.toHex();
    yield validatorServices[publicKey].stop();

    yield put(stopValidatorService(publicKey));
}

function* setValidatorBeacon({
    payload,
    meta,
}: ReturnType<typeof setValidatorBeaconNode>): Generator<
    PutEffect | SelectEffect | Promise<ValidatorBeaconNodes> | Promise<ValidatorStatus>,
    void,
    ValidatorBeaconNodes & IValidator & ValidatorStatus
> {
    const beaconNodes = yield database.validatorBeaconNodes.update(meta, payload);
    yield put(storeValidatorBeaconNodes(beaconNodes.nodes, meta));
    const validator = yield select(getValidator, {publicKey: meta});
    if (validator.status === ValidatorStatus.NO_BEACON_NODE) {
        const beacon = validator.beaconNodes.length ? validator.beaconNodes[0] : beaconNodes.nodes[0];
        const status = yield getValidatorStatus(meta, beacon);
        yield put(setValidatorStatus(status, meta));
    }
}

function* validatorInfoUpdater(
    publicKey: string,
    network: string,
): Generator<
    SelectEffect | PutEffect | CancelEffect | RaceEffect<TakeEffect> | Promise<undefined | bigint> | Promise<void>,
    void,
    IValidator &
        [ReturnType<typeof removeActiveValidator>, ReturnType<typeof getNewValidatorBalance>] &
        (undefined | bigint)
> {
    while (true) {
        try {
            const [cancelAction, {payload}] = yield race([take(removeActiveValidator), take(getNewValidatorBalance)]);
            if (cancelAction && cancelAction.payload === publicKey) {
                yield cancel();
            }

            const validator = yield select(getValidator, {publicKey});
            if (validator.beaconNodes.includes(payload.beacon)) {
                const balance = yield getValidatorBalance(publicKey, network, payload.beacon, payload.slot);
                if (balance) {
                    yield database.validator.balance.addRecords(publicKey, [{balance, epoch: BigInt(payload.slot)}]);
                    yield put(updateValidatorBalance(publicKey, balance));
                }
            }
        } catch (err) {
            logger.error("update validator error:", err.message);
        }
    }
}

// TODO: add types
function* getAttestationEffectiveness({payload, meta}: ReturnType<typeof signedNewAttestation>): any {
    const validator = yield select(getValidator, {publicKey: meta});
    const config = getNetworkConfig(validator.network)?.eth2Config || mainnetConfig;

    const eth2API = new CgEth2ApiClient(config, validator.beaconNodes[0]);

    let lastSlot = payload.slot,
        previousSlot = 0,
        empty = 0,
        skipped = 0,
        skippedQue = 0,
        inclusion = 0;
    const timeoutSlot = config.params.SLOTS_PER_EPOCH + payload.slot;
    while (true) {
        const newSlot = yield take(updateSlot);
        if (newSlot.meta !== validator.beaconNodes[0]) continue;
        if (lastSlot >= newSlot.payload) continue;
        if (newSlot.payload > timeoutSlot) break;

        const range = new Array(newSlot.payload - lastSlot).fill(null).map((_, index) => lastSlot + index + 1);
        const results = yield all(range.map((slot) => call(eth2API.beacon.blocks.getBlockAttestations, slot)));
        results.forEach((result, index) => {
            if (result === null) {
                skippedQue++;
            } else {
                const sanitizedAttestations = result.filter(
                    ({data}) => payload.block === data.beaconBlockRoot && data.index === payload.index,
                );
                if (!sanitizedAttestations.length) empty++;
                else empty = 0;
                sanitizedAttestations.forEach(({data}) => {
                    if (data.slot > inclusion && data.slot > payload.slot) {
                        inclusion = data.slot;
                        if (data.slot === payload.slot + 1 && skippedQue === 1) skippedQue--;
                        skipped += skippedQue;
                        skippedQue = 0;
                    }
                });
                previousSlot = range[index];
            }
        });

        if (previousSlot !== 0 && empty >= 3 + skippedQue) break;
        lastSlot = newSlot.payload;
    }
    // Hack to handle some case when there is no record of attestation
    // TODO: figure out why is this happening
    if (!inclusion) {
        inclusion = payload.slot + 1;
        skipped = 0;
    }

    const epoch = computeEpochAtSlot(config, payload.slot);
    const efficiency = (payload.slot + 1 + skipped - payload.slot) / (inclusion - payload.slot);
    yield database.validator.attestationEffectiveness.addRecord(meta, {
        epoch,
        inclusion,
        slot: payload.slot,
        efficiency: efficiency > 1 ? 1 : efficiency,
        time: Date.now(),
    });
}

export function* validatorSagaWatcher(): Generator {
    yield all([
        takeEvery(loadValidatorsAction, loadValidatorsSaga),
        takeEvery(addNewValidator, addNewValidatorSaga),
        takeEvery(removeActiveValidator, removeValidatorSaga),
        takeEvery(startNewValidatorService, startService),
        takeEvery(stopActiveValidatorService, stopService),
        takeEvery(setValidatorBeaconNode, setValidatorBeacon),
        takeEvery(signedNewAttestation, getAttestationEffectiveness),
    ]);
}
