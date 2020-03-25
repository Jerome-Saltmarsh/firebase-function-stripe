const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
const stripe = require('stripe')('sk_test_lBGmeivyP5cd4ZuYvwi1z0MX00iagSjM77');

exports.onUserCreated = functions.auth.user().onCreate(async (userRecord, context) => {

    console.log("onUserCreated()")

    const firebaseUid = userRecord.uid;
    const customer = await stripe.customers.create({
        email: userRecord.email,
        metadata: { firebaseUid }
    });

    return db.doc('users/'+ firebaseUid).update(
        {
            stripeId: customer.id
        }
    )
});

// function createUser(email) {
//     stripe.customers.create({
//         email: email,
//     })
//         .then(customer => console.log("New stripe customer added: " + customer.id))
//         .catch(error => console.error(error));

// }

