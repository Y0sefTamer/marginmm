// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {MakerTraits} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {MarginMMPolicy} from "../src/MarginMMPolicy.sol";
import {MarginMMScenarioEngine} from "../src/MarginMMScenarioEngine.sol";
import {MarginMMSwapVMRouter} from "../src/MarginMMSwapVMRouter.sol";

interface IMarginPool {
    function supply(address, uint256, address, uint16) external;
    function borrow(address, uint256, uint256, uint16, address) external;
    function setUserUseReserveAsCollateral(address, bool) external;
    function getUserAccountData(address) external view returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

interface IMarginWETH is IERC20 {
    function deposit() external payable;
}

contract MarginMMIntegrationTest is Test {
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant DATA = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address constant ORACLE = 0x54586bE62E3c3580375aE3723C145253060Ca0C2;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 constant FORK_BLOCK = 25_913_344;

    address maker = makeAddr("maker");
    address taker = makeAddr("taker");
    address receiver = makeAddr("receiver");
    Aqua aqua;
    MarginMMScenarioEngine engine;
    MarginMMPolicy policy;
    MarginMMSwapVMRouter router;
    ISwapVM.Order order;
    bytes32 strategy;
    address aWETH;
    address aUSDC;

    function setUp() public {
        vm.createSelectFork(vm.envString("ETH_RPC_URL"), FORK_BLOCK);
        aqua = new Aqua();
        engine = new MarginMMScenarioEngine(POOL, DATA, ORACLE);
        policy = new MarginMMPolicy();
        router = new MarginMMSwapVMRouter(
            address(aqua), WETH, address(engine), address(policy), address(this), "MarginMM", "1"
        );
        aWETH = engine.aWETH();
        aUSDC = engine.aUSDC();
        _supply(maker, 10 ether, 50_000e6);
        vm.prank(maker);
        IMarginPool(POOL).borrow(USDC, 46_000e6, 2, 0, maker);
        _supply(taker, 100 ether, 200_000e6);

        order = router.buildOrder(maker, 10, keccak256("demo-strategy"));
        strategy = router.hash(order);
        assertEq(strategy, keccak256(abi.encode(order)));
        address[] memory tokens = new address[](2);
        tokens[0] = aWETH;
        tokens[1] = aUSDC;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = IERC20(aWETH).balanceOf(maker);
        amounts[1] = IERC20(aUSDC).balanceOf(maker);
        vm.startPrank(maker);
        IERC20(aWETH).approve(address(aqua), type(uint256).max);
        IERC20(aUSDC).approve(address(aqua), type(uint256).max);
        assertEq(aqua.ship(address(router), abi.encode(order), tokens, amounts), strategy);
        policy.setRiskFloor(strategy, 1.1e18);
        vm.stopPrank();
        vm.startPrank(taker);
        IERC20(aWETH).approve(address(router), type(uint256).max);
        IERC20(aUSDC).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function testFork_PartialFillSettlesActualATokensAndPreservesBothGuards() public {
        uint256 requested = 50_000e6;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, requested);
        assertGt(c.qMax, 0);
        assertLt(c.qMax, requested);
        assertEq(c.amountOut, c.qMax);
        bytes memory data = _data(c, c.amountOut);
        vm.prank(taker);
        (uint256 quoteIn, uint256 quoteOut,) = router.quote(order, aWETH, aUSDC, requested, data);
        assertEq(quoteIn, c.amountIn);
        assertEq(quoteOut, c.amountOut);

        uint256 makerInBefore = IERC20(aWETH).balanceOf(maker);
        uint256 makerOutBefore = IERC20(aUSDC).balanceOf(maker);
        uint256 takerOutBefore = IERC20(aUSDC).balanceOf(taker);
        vm.prank(taker);
        (uint256 filledIn, uint256 filledOut,) = router.swap(order, aWETH, aUSDC, requested, data);
        assertEq(filledIn, quoteIn);
        assertEq(filledOut, quoteOut);
        assertGe(IERC20(aWETH).balanceOf(maker) - makerInBefore, filledIn);
        assertGe(makerOutBefore - IERC20(aUSDC).balanceOf(maker), filledOut);
        assertGe(IERC20(aUSDC).balanceOf(taker) - takerOutBefore, filledOut);
        MarginMMScenarioEngine.State memory afterState = engine.snapshot(maker);
        assertGt(afterState.aaveHF, 1e18);
        assertGe(engine.stressHF(afterState), 1.1e18);
    }

    function testFork_ReverseDirectionUsesFullSafeCapacity() public {
        uint256 requested = 1 ether;
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aUSDC, aWETH, requested);
        assertEq(c.amountOut, requested);
        bytes memory data = _data(c, requested);
        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, aUSDC, aWETH, requested, data);
        assertEq(amountIn, c.amountIn);
        assertEq(amountOut, requested);
        MarginMMScenarioEngine.State memory s = engine.snapshot(maker);
        assertGt(s.aaveHF, 1e18);
        assertGe(engine.stressHF(s), 1.1e18);
    }

    function testFork_ChangedPolicyInvalidatesReviewedMinimumOutputBeforeTransfers() public {
        uint256 requested = 50_000e6;
        MarginMMSwapVMRouter.FillCapacity memory oldC = router.capacity(order, aWETH, aUSDC, requested);
        bytes memory data = _data(oldC, oldC.amountOut);
        uint256 beforeIn = IERC20(aWETH).balanceOf(taker);
        uint256 beforeOut = IERC20(aUSDC).balanceOf(taker);
        vm.prank(maker);
        policy.setRiskFloor(strategy, 1.12e18);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.MinimumOutputNotMet.selector);
        router.swap(order, aWETH, aUSDC, requested, data);
        assertEq(IERC20(aWETH).balanceOf(taker), beforeIn);
        assertEq(IERC20(aUSDC).balanceOf(taker), beforeOut);
    }

    function testFork_ChangedAaveStateRejectsStaleFillBeforeTransfers() public {
        uint256 requested = 50_000e6;
        MarginMMSwapVMRouter.FillCapacity memory oldC = router.capacity(order, aWETH, aUSDC, requested);
        bytes memory data = _data(oldC, oldC.amountOut);
        vm.prank(maker);
        assertTrue(IERC20(aUSDC).transfer(receiver, 5_000e6));
        assertGt(engine.snapshot(maker).aaveHF, 1e18);
        assertLt(engine.stressHF(engine.snapshot(maker)), 1.1e18);
        uint256 beforeIn = IERC20(aWETH).balanceOf(taker);
        uint256 beforeOut = IERC20(aUSDC).balanceOf(taker);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.NoCapacity.selector);
        router.swap(order, aWETH, aUSDC, requested, data);
        assertEq(IERC20(aWETH).balanceOf(taker), beforeIn);
        assertEq(IERC20(aUSDC).balanceOf(taker), beforeOut);
    }

    function testFork_TakerBoundsIncludeATokenDebitRounding() public {
        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, 1_000e6);
        bytes memory tooTight = router.buildTakerData(c.amountIn, c.amountOut, uint40(block.timestamp + 1 hours));
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedTakerData.selector);
        router.quote(order, aWETH, aUSDC, 1_000e6, tooTight);
        bytes memory bounded = _data(c, c.amountOut);
        vm.prank(taker);
        router.quote(order, aWETH, aUSDC, 1_000e6, bounded);
    }

    function testFork_RejectsNonCanonicalProgramAndTakerCallbacks() public {
        ISwapVM.Order memory bad = order;
        bad.traits = MakerTraits.wrap(MakerTraits.unwrap(order.traits) | (1 << 252));
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedStrategy.selector);
        router.capacity(bad, aWETH, aUSDC, 1_000e6);

        MarginMMSwapVMRouter.FillCapacity memory c = router.capacity(order, aWETH, aUSDC, 1_000e6);
        TakerTraitsLib.Args memory args;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.hasPreTransferInCallback = true;
        args.preTransferInCallbackData = hex"01";
        args.threshold = abi.encode(c.amountIn + c.inputRounding);
        args.deadline = uint40(block.timestamp + 1 hours);
        args.instructionsArgs = abi.encode(c.amountOut);
        vm.prank(taker);
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedTakerData.selector);
        router.quote(order, aWETH, aUSDC, 1_000e6, TakerTraitsLib.build(args));
    }

    function testFork_DisabledPolicyAndUnsupportedPairsFailClosed() public {
        vm.prank(maker);
        policy.setRiskFloor(strategy, 0);
        vm.expectRevert(MarginMMSwapVMRouter.PolicyDisabled.selector);
        router.capacity(order, aWETH, aUSDC, 1_000e6);
        vm.prank(maker);
        policy.setRiskFloor(strategy, 1.1e18);
        vm.expectRevert(MarginMMSwapVMRouter.UnsupportedPair.selector);
        router.capacity(order, aWETH, USDC, 1_000e6);
    }

    function _data(MarginMMSwapVMRouter.FillCapacity memory c, uint256 minOut) internal view returns (bytes memory) {
        return router.buildTakerData(c.amountIn + c.inputRounding, minOut, uint40(block.timestamp + 1 hours));
    }

    function _supply(address user, uint256 wethAmount, uint256 usdcAmount) internal {
        vm.deal(user, wethAmount);
        deal(USDC, user, usdcAmount);
        vm.startPrank(user);
        IMarginWETH(WETH).deposit{value: wethAmount}();
        IERC20(WETH).approve(POOL, wethAmount);
        IERC20(USDC).approve(POOL, usdcAmount);
        IMarginPool(POOL).supply(WETH, wethAmount, user, 0);
        IMarginPool(POOL).supply(USDC, usdcAmount, user, 0);
        IMarginPool(POOL).setUserUseReserveAsCollateral(WETH, true);
        IMarginPool(POOL).setUserUseReserveAsCollateral(USDC, true);
        vm.stopPrank();
    }
}
