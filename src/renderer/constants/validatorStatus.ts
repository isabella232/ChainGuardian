export enum ValidatorStatus {
    // chain guardian statuses
    NO_BEACON_NODE = "Missing Beacon Node",
    WAITING_DEPOSIT = "Waiting for a deposit",
    PROCESSING_DEPOSIT = "Processing a deposit",
    // "official" statuses
    DEPOSITED = "Funds deposited",
    QUEUE = "Queue for activation",
    PENDING = "Eligible to be activated",
    ACTIVE = "Active",
    GOOD_BOY_EXITING = "Slashed and exiting",
    SLASHED_EXITING = "Slashed and exiting",
    SLASHED = "Slashed exited",
    VOLUNTARILY_EXITED = "Voluntarily exited",
    WITHDRAWABLE = "Withdrawable",
    WITHDRAWNED = "withdrawned",
    //
    ERROR = "Some error occurred",
}
