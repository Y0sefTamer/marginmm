// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {MarginMMRiskEngine} from "../src/MarginMMRiskEngine.sol";
import {MarginMMAquaPosition} from "../src/MarginMMAquaPosition.sol";
import {MarginMMPricing} from "../src/MarginMMPricing.sol";

contract DeployMarginMM is Script {
    function run()
        external
        returns (MarginMMRiskEngine riskEngine, MarginMMAquaPosition aquaLens, MarginMMPricing pricing)
    {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address pool = vm.envAddress("AAVE_POOL");
        address dataProvider = vm.envAddress("AAVE_DATA_PROVIDER");
        address oracle = vm.envAddress("AAVE_ORACLE");

        vm.startBroadcast(deployerKey);

        // Demo defaults: 10% stressed HF floor, 5% collateral haircut, 5% debt shock.
        riskEngine = new MarginMMRiskEngine(pool, dataProvider, oracle, 1.10e18, 9_500, 10_500);
        aquaLens = new MarginMMAquaPosition(address(riskEngine));
        pricing = new MarginMMPricing(1.10e18, 1.50e18, 10, 50);

        vm.stopBroadcast();
    }
}
