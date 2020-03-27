const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const stripe = require('stripe')('sk_test_lBGmeivyP5cd4ZuYvwi1z0MX00iagSjM77');

exports.onUserCreated = functions.auth.user().onCreate(async (userRecord, context) => {

    const firebaseUid = userRecord.uid;
    const customer = await stripe.customers.create({
        email: userRecord.email,
        metadata: { firebaseUid }
    });

    console.log("New user registered to stripe");

    return db.doc('users/' + firebaseUid).update(
        {
            stripeId: customer.id
        }
    )
});

exports.registerUserWithStripe = functions.https.onRequest(async (request, response) => {

    var userId = request.body.userId;
    const userDoc = await db.doc('users/' + userId).get();
    const user = userDoc.data();
    var email = user.email;

    const customer = await stripe.customers.create({
        email: email,
        metadata: { userId }
    });


    db.doc('users/' + userId).update(
        {
            stripeId: customer.id
        }
    );

    response.send("New Stripe Customer Registered");
});

exports.addCard = functions.https.onCall(async (data, context) => {

    const userId = context.auth.uid;
    const userDoc = await db.doc('users/' + userId).get();
    const user = userDoc.data();
    const source = await stripe.customers.createSource(user.stripeId, { source: data });

    if (source != null) {
        console.log("New card registered to stripe");
    } else {
        console.log("Failed to register card with stripe");
    }
});

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {

    const paymentIntent = await stripe.paymentIntents.create({
        amount: 1099,
        currency: 'eur',
        // Verify your integration in this guide by including this parameter
        metadata: { integration_check: 'accept_a_payment' },
    });

    if (paymentIntent == null) {
        console.error("Failed to create payment intent");
        retrurn;
    }

    if (paymentIntent.client_secret == null) {
        console.error("Payment intent missing client_secret");
        retrurn;
    }

    return { clientSecret: paymentIntent.client_secret };
});

exports.createPaymentMethod = functions.https.onCall(async (data, context) => {

    const user = await getUserfromContext(context);

    if (user == null) {
        console.error("Missing authenticated user");
        return;
    }

    if(user.stripeId == null){
        console.error("User is missing stripeId");
        return;
    }

    await stripe.paymentMethods.create(
        data,
        function (err, paymentMethod) {

            if (err != null) {
                console.error(err.toString());
                return;
            }

            if(paymentMethod.id == null){
                console.error("PaymentId is missing");
                return;
            }

            attachPaymentMethodToCustomer(paymentMethod.id, user.stripeId);
        }
    );
});

exports.confirmPaymentMethod = functions.https.onCall(async (data, context) => {

    const { paymentIntent, error } = await stripe.confirmCardPayment(
        '{PAYMENT_INTENT_CLIENT_SECRET}',
        {
            payment_method: '{PAYMENT_METHOD_ID}',
        },
    );
});

// exports.createPaymentMethodWithCard = functions.https.onCall(async (data, context) => {

//     if (data.card == null) {
//         console.error("Missing card");
//         return;
//     }

//     if (data.clientSecret == null) {
//         console.error("Missing clientSecret");
//         return;
//     }

//     const response = await stripe.paymentMethods.create(
//         data.card,
//         function async(err, paymentMethod) {

//             if (err != null) {
//                 console.error(err.toString());
//                 return;
//             }

//             if (data.clientSecret == null) {
//                 console.error("Missing clientSecret");
//                 return;
//             }

//             if (paymentMethod == null || paymentMethod.id == null) {
//                 console.error("Missing paymentMethod id");
//             }

//             console.log("Confirming Card Payment");

//             const { paymentIntent, error } = await stripe.confirmCardPayment(
//                 data.clientSecret,
//                 {
//                     payment_method: paymentMethod.id,
//                 },
//             );

//             if (error != null) {
//                 console.error(error.toString());
//                 return;
//             }

//             console.log("Confirming Card Payment Completed");

//             return paymentIntent;
//         }
//     );

//     return response;
// });

exports.createEphemeralKey = functions.https.onCall(async (data, context) => {

    const userId = context.auth.uid;
    console.log("creating ephemeral key for user " + userId);
    const user = await getUser(userId);

    if (user == null) {
        console.error("Cannot find user with id " + userId);
        return;
    }

    if (user.stripeId == null) {
        console.error("Cannot create ephemeral key because user does not have an associated Stripe customer record");
        return;
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: user.stripeId },
        { apiVersion: apiVersion }
    );

    if (ephemeralKey != null) {
        console.log("new ephemeral key created");
    }

    return ephemeralKey;
});

async function attachPaymentMethodToCustomer(paymentMethodId, customerId) {
    stripe.paymentMethods.attach(
        paymentMethodId,
        { customer: customerId },
        function (err, paymentMethod) {
            // asynchronously called
        }
    );
}

async function getUserfromContext(context) {
    return getUser(context.auth.uid);
}

async function getUser(userId) {
    const userDoc = await db.doc('users/' + userId).get();
    return userDoc.data();
}

