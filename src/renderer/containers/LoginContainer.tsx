import * as React from "react";
import {Background} from "../components/Background/Background";
import {Modal} from "../components/Modal/Modal";
import {InputForm} from "../components/Input/InputForm";
import {ButtonPrimary, ButtonSecondary} from "../components/Button/ButtonStandard";

export default class LoginContainer extends React.Component {
    render() {
        return (
            <Background>
                <Modal>
                    <h1>Welcome!</h1>
                    <p>Please enter your password or set up an account to get started.</p>
                    <div style={{display: "flex", alignItems: "center"}}>
                        <InputForm />
                        <ButtonSecondary>GO</ButtonSecondary>
                    </div>
                    <h5>OR</h5>
                    <ButtonPrimary>REGISTER</ButtonPrimary>
                </Modal>
            </Background>
        );
    }
}