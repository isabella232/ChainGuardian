import {CgEth2BeaconPoolApi} from "../eth2ApiClient/cgEth2BeaconPoolApi";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {HttpClient} from "../../../api";
import {Dispatch} from "redux";
import {Attestation} from "@chainsafe/lodestar-types";
import {signedNewAttestation} from "../../../../ducks/validator/actions";
import {toHex} from "@chainsafe/lodestar-utils";
import {hexToBase64} from "./utils";
import {Attestation as PrysmAttestation} from "./types";

type AttestationData = {
    aggregationBits: string;
    data: {
        slot: string;
        index: string;
        beaconBlockRoot: string;
        source: {
            epoch: string;
            root: string;
        };
        target: {
            epoch: string;
            root: string;
        };
    };
    signature: string;
};

export class CgPrysmEth2BeaconPoolApi extends CgEth2BeaconPoolApi {
    public constructor(config: IBeaconConfig, httpClient: HttpClient, publicKey?: string, dispatch?: Dispatch) {
        super(config, httpClient, publicKey, dispatch);
    }

    public submitAttestation = async (attestation: Attestation): Promise<void> => {
        if (this.publicKey && this.dispatch) {
            const validatorIndexInCommittee = attestation.aggregationBits.findIndex((bit) => bit);
            if (validatorIndexInCommittee !== -1)
                this.dispatch(
                    signedNewAttestation(
                        this.publicKey,
                        toHex(attestation.data.beaconBlockRoot),
                        attestation.data.index,
                        attestation.data.slot,
                        validatorIndexInCommittee,
                    ),
                );
        }
        const data = this.config.types.Attestation.toJson(attestation) as AttestationData;
        const mapped: PrysmAttestation = {
            // eslint-disable-next-line camelcase,@typescript-eslint/camelcase
            aggregation_bits: hexToBase64(data.aggregationBits),
            data: {
                slot: data.data.slot,
                // eslint-disable-next-line camelcase,@typescript-eslint/camelcase
                committee_index: data.data.index,
                // eslint-disable-next-line camelcase,@typescript-eslint/camelcase
                beacon_block_root: hexToBase64(data.data.beaconBlockRoot),
                source: {
                    epoch: data.data.source.epoch,
                    root: hexToBase64(data.data.source.root),
                },
                target: {
                    epoch: data.data.target.epoch,
                    root: hexToBase64(data.data.target.root),
                },
            },
            signature: hexToBase64(data.signature),
        };
        await this.httpClient.post("/eth/v1alpha1/validator/attestation", mapped);
    };

    // TODO: implement method "submitVoluntaryExit"
}
