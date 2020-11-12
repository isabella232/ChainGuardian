export class Routes {
    public static DASHBOARD_ROUTE = "/dashboard";
    public static LOGIN_ROUTE = "/login";
    public static ONBOARD_ROUTE = "/onboard/:step";
    public static VALIDATOR_DETAILS = "/details/:publicKey";
    public static BEACON_NODES = "/beacon-nodes";
    public static ADD_BEACON_NODE = "/add-beacon-node/:validatorKey";
    public static ONBOARD_ROUTE_EVALUATE = (step: OnBoardingRoutes): string => `/onboard/${step}`;
}

export enum OnBoardingRoutes {
    SIGNING = "1_0",
    SIGNING_IMPORT_FILE = "1_1",
    SIGNING_IMPORT_MNEMONIC = "1_2",
    PASSWORD = "2_0",
    CONSENT = "3_0",
}
