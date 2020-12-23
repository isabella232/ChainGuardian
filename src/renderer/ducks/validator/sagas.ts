import {all, put, PutEffect, select, SelectEffect, takeEvery} from "redux-saga/effects";
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
} from "./actions";
import {ICGKeystore} from "../../services/keystore";
import {unsubscribeToBlockListening} from "../network/actions";
import {SlashingProtection, Validator} from "@chainsafe/lodestar-validator";
import * as logger from "electron-log";
import {getAuthAccount} from "../auth/selectors";
import {getValidatorBeaconNodes} from "./selectors";
import {ValidatorBeaconNodes} from "../../models/validatorBeaconNodes";
import {CgEth2ApiClient} from "../../services/eth2/client/eth2ApiClient";
import {WinstonLogger} from "@chainsafe/lodestar-utils";
import {Beacon} from "../beacon/slice";
import {readBeaconChainNetwork} from "../../services/eth2/client";
import {INetworkConfig} from "../../services/interfaces";
import {getValidatorBalance} from "../../services/utils/validator";
import {getValidatorState} from "../../services/utils/getValidatorState";

interface IValidatorServices {
    [validatorAddress: string]: Validator;
}

const validatorServices: IValidatorServices = {};

function* loadValidatorsSaga(): Generator<
    SelectEffect | PutEffect | Promise<ICGKeystore[]> | Promise<ValidatorBeaconNodes[]> | Promise<IValidator[]>,
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
                    status: await getValidatorState(keyStore.getPublicKey(), beaconNodes?.nodes[0]),
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
    }
}

export function* addNewValidatorSaga(action: ReturnType<typeof addNewValidator>): Generator<PutEffect> {
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
    SelectEffect | PutEffect | Promise<void> | Promise<INetworkConfig | null>,
    void,
    Beacon[] & (INetworkConfig | null)
> {
    try {
        const publicKey = action.payload.publicKey.toHex();
        const beaconNodes = yield select(getValidatorBeaconNodes, {publicKey});
        if (!beaconNodes.length) {
            throw new Error("missing beacon node");
        }

        const config = (yield readBeaconChainNetwork(beaconNodes[0].url))?.eth2Config || mainnetConfig;

        // TODO: Use beacon chain proxy instead of first node
        const eth2API = new CgEth2ApiClient(config, beaconNodes[0].url);

        const slashingProtection = new SlashingProtection({
            config,
            controller: cgDbController,
        });

        const logger = new WinstonLogger() as ValidatorLogger;

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
    PutEffect | Promise<ValidatorBeaconNodes>,
    void,
    ValidatorBeaconNodes
> {
    const beaconNodes = yield database.validatorBeaconNodes.upsert(meta, [payload]);
    yield put(storeValidatorBeaconNodes(beaconNodes.nodes, meta));
}

export function* validatorSagaWatcher(): Generator {
    yield all([
        takeEvery(loadValidatorsAction, loadValidatorsSaga),
        takeEvery(addNewValidator, addNewValidatorSaga),
        takeEvery(removeActiveValidator, removeValidatorSaga),
        takeEvery(startNewValidatorService, startService),
        takeEvery(stopActiveValidatorService, stopService),
        takeEvery(setValidatorBeaconNode, setValidatorBeacon),
    ]);
}
