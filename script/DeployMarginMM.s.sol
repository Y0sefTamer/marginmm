// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {MarginMMScenarioEngine} from "../src/MarginMMScenarioEngine.sol";
import {MarginMMPolicy} from "../src/MarginMMPolicy.sol";
import {MarginMMSwapVMRouter} from "../src/MarginMMSwapVMRouter.sol";

interface IDeployProvider {
    function getPoolDataProvider() external view returns (address);
    function getPriceOracle() external view returns (address);
}

contract DeployMarginMM is Script {
    address private constant MAINNET_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant MAINNET_PROVIDER = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e;

    function run()
        external
        returns (Aqua aqua, MarginMMScenarioEngine riskEngine, MarginMMPolicy policy, MarginMMSwapVMRouter router)
    {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(deployerKey);
        address provider = MAINNET_PROVIDER;
        address pool = MAINNET_POOL;
        address dataProvider = IDeployProvider(provider).getPoolDataProvider();
        address oracle = IDeployProvider(provider).getPriceOracle();

        vm.startBroadcast(deployerKey);
        aqua = new Aqua();
        riskEngine = new MarginMMScenarioEngine(pool, dataProvider, oracle);
        policy = new MarginMMPolicy();
        router = new MarginMMSwapVMRouter(
            address(aqua), riskEngine.WETH(), address(riskEngine), address(policy), owner, "MarginMM", "1"
        );
        vm.stopBroadcast();
    }
}
