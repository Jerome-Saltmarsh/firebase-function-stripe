const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const stripe = require('stripe')('sk_test_lBGmeivyP5cd4ZuYvwi1z0MX00iagSjM77');


// exports.onEventCreated = functions.firestore
//     .document('/events/{eventId}')
//     .onCreate((documentSnapshot, context) => {

//         const eventId = getEventIdFromContext(context);
//         const userId = getUserIdFromContext(context);
//         // documentSnapshot.ref.update({
//         //     'createdBy': userId
//         // })
//         console.log("event: " + eventId + " created by user:" + userId);
//     });

// exports.onEventUpdated = functions.firestore
//     .document('/events/{eventId}')
//     .onUpdate((change, context) => {

//         console.log("Change detected " + eventId);
//     });

// BEGIN EVENT_SERVICE

exports.attendEvent = functions.https.onCall(async (data, context) => {

    const userId = getUserIdFromContext(context);
    // const user = await findUserById(userId);

    if (data.eventId == null) {
        throw Error("eventId is null");
    }

    const eventId = data.eventId;
    const event = await findEventById(eventId);

    if (event.ticketPrice != null && event.ticketPrice > 0) {
        await payForEvent(userId, eventId, data.paymentMethodId);
    }

    if (event.attending == null) {
        event.attending = [];
    }

    if (event.attending.includes(userId)) {
        throw Error(`user: ${userId} is already attending event: ${eventId}`);
    }

    event.attending.push(userId);
    await updateEvent(eventId, { 'attending': event.attending });
    console.log(`user: ${userId} is now attending event: ${eventId}`);
});

exports.unattendEvent = functions.https.onCall(async (data, context) => {

    const userId = getUserIdFromContext(context);

    if (data.eventId == null) {
        throw Error("eventId is null");
    }

    const eventId = data.eventId;
    const event = await findEventById(eventId);

    if (!event.attending.includes(userId)) {
        throw Error('user: ' + userId + ' is not attending event: ' + eventId);
    }

    event.attending = event.attending.filter((id) => id !== userId);
    await updateEvent(eventId, { 'attending': event.attending });
    console.log(`user:` + userId + ' is no longer attending event: ' + eventId);
});

// END EVENT SERVICE

// BEGIN PAYMENT SERVICE

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {

    const userId = getUserIdFromContext(context);
    const user = await findUserById(userId);
    const customerId = await getCustomerId(user);

    if (data.amount == null) {
        throw Error("amount is required");
    }

    if (data.currency == null) {
        throw Error("currency is required");
    }

    const amount = data.amount;
    const currency = data.currency;
    const paymentMethodId = data.paymentMethodId;
    const confirm = paymentMethodId != null;

    const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: currency,
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: confirm,
        receipt_email: user.email,
        metadata: { integration_check: 'accept_a_payment' },
    });

    if (paymentIntent == null) {
        throw Error("Failed to create payment intent");
    }

    if (paymentIntent.client_secret == null) {
        throw Error("Payment intent missing client_secret");
    }

    return { paymentIntentId: paymentIntent.id };
});

exports.createPaymentMethod = functions.https.onCall(async (card, context) => {

    const userId = getUserIdFromContext(context);
    const user = await findUserById(userId);
    const customerId = await getCustomerId(user)

    if (card == null) {
        throw Error("card is null");
    }

    await stripe.paymentMethods.create(
        card,
        function (error, paymentMethod) {

            if (error != null) {
                throw Error(error.toString());
            }

            if (paymentMethod.id == null) {
                throw Error("paymentMethod.id is null");
            }

            attachPaymentMethodToCustomer(userId, customerId, paymentMethod.id);
        }
    );
});

exports.detachPaymentMethod = functions.https.onCall(async (data, context) => {

    ensureAuthenticated(context);

    if (data.paymentMethodId == null) {
        throw Error("paymentMethodId is null");
    }

    return await stripe.paymentMethods.detach(data.paymentMethodId);
});

exports.retrievePaymentMethods = functions.https.onCall(async (data, context) => {

    const userId = getUserIdFromContext(context);
    const user = await findUserById(userId);

    if (user.stripeId == null) {
        return [];
    }

    const paymentMethodsResponse = await stripe.paymentMethods.list({ customer: user.stripeId, type: 'card' });
    return paymentMethodsResponse.data;
});


exports.confirmPaymentIntent = functions.https.onCall(async (data, context) => {

    const userId = getUserIdFromContext(context);
    const user = await findUserById(userId);

    if (data.paymentIntentId == null) {
        throw Error("paymentIntentId is null");
    }

    if (user.paymentMethodId == null) {
        throw Error("user.paymentMethodId is null");
    }

    const paymentIntentId = data.paymentIntentId;
    const paymentMethodId = user.paymentMethodId;

    return await confirmPaymentIntent(paymentIntentId, paymentMethodId);
});

// END PAYMENT SERVICE

// Model Functions

async function attachPaymentMethodToCustomer(userId, customerId, paymentMethodId) {

    if (userId == null) {
        throw Error("userId is null");
    }

    if (customerId == null) {
        throw Error("customerId is null");
    }

    if (paymentMethodId == null) {
        throw Error("paymentMethodId is null");
    }

    return await stripe.paymentMethods.attach(
        paymentMethodId,
        { customer: customerId },
        function (error, paymentMethod) {

            if (error != null) {
                console.error(error.toString());
                return;
            }

            console.log("Attaching payment method to user db");

            updateUser(userId, {
                paymentMethodId: paymentMethod.id
            });

            return paymentMethod;
        }
    );
}

async function payForEvent(userId, eventId, paymentMethodId) {

    if (paymentMethodId == null) {
        throw Error("paymentMethodId is null");
    }

    const user = await findUserById(userId);
    const customerId = await getCustomerId(user);
    const event = await findEventById(eventId);
    const ticketPrice = event.ticketPrice;

    if (ticketPrice == null) {
        throw Error(event.title + " ticketPrice is null");
    }
    if (ticketPrice <= 0) {
        throw Error(event.title + "event.ticketPrice is less than or equal to zero");
    }

    const currency = 'eur';
    const amount = ticketPrice * 100;

    const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: currency,
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        receipt_email: user.email,
        metadata: { integration_check: 'accept_a_payment' },
    });

    if (paymentIntent == null) {
        throw Error("Failed to create payment intent");
    }

    if (paymentIntent.client_secret == null) {
        throw Error("Payment intent missing client_secret");
    }

    return { paymentIntentId: paymentIntent.id };
}

async function confirmPaymentIntent(paymentIntentId, paymentMethodId) {

    if (paymentIntentId == null) {
        throw Error("paymentIntentId is required");
    }
    if (paymentMethodId == null) {
        throw Error("paymentMethodId is required");
    }

    const { paymentIntent, error } = await stripe.paymentIntents.confirm(
        paymentIntentId,
        {
            payment_method: paymentMethodId,
        },
    );

    if (error != null) {
        console.error(error.toString());
        return;
    }

    return paymentIntent;
}

// Utilities

function getEventIdFromContext(context) {

    if (context == null) {
        throw Error("context is null");
    }

    if (context.params == null) {
        throw Error("context.params is null");
    }

    if (context.params.eventId == null) {
        throw Error("context.params.eventId is null");
    }

    return context.params.eventId;
}

function getUserIdFromContext(context) {

    if (context == null) {
        throw Error("context is null");
    }

    if (context.auth == null) {
        throw Error("context.auth is null");
    }

    if (context.auth.uid == null) {
        throw Error("context.auth.id is null");
    }

    return context.auth.uid;
}

async function findEventById(eventId) {
    return findById('events', eventId);
}

async function findUserById(userId) {
    return findById('users', userId);
}

async function findById(collection, id) {

    if (id == null) {
        throw Error("id is null");
    }
    if (collection == null) {
        throw Error("collection is null");
    }

    const doc = await db.doc(collection + '/' + id).get();

    if (doc == null) {
        throw Error("Could not find ${collection}/${id}");
    }

    return  doc.data();
}

async function updateUser(userId, data) {

    if (userId == null) {
        throw Error("userId is null");
    }
    return await db.doc('users/' + userId).update(data);
}

async function updateEvent(eventId, data) {
    if (eventId == null) {
        throw Error("eventId is null");
    }
    return await db.doc('events/' + eventId).update(data);
}

function ensureAuthenticated(context) {
    const userId = getUserIdFromContext(context);
    const user = findUserById(userId);
    if (user == null) {
        throw Error("No authenticated user");
    }
}

async function getCustomerId(user) {
    if (user == null) {
        throw Error("user is null");
    }
    if (user.stripeId == null || user.stripeId == "") {
        user.stripeId = await addCustomer(user.id, user.email);
    }

    if (user.stripeId == null) {
        throw Error("Could not get stripe id");
    }

    return user.stripeId;
}

async function addCustomer(userId, email) {

    const user = await findUserById(userId);

    if (user.stripeId != null) {
        console.warn(email + " already has a stripe id");
        return user.stripeId;
    }

    console.log("Registering user " + userId + " as new stripe customer " + email);

    const customer = await stripe.customers.create({
        email: email,
        metadata: { userId }
    });

    if (customer == null) {
        throw Error("customer is null");
    }

    if (customer.id == null) {
        throw Error("customer.id is null");
    }

    if (customer.id == "") {
        throw Error("Customer.id is blank string");
    }

    console.log("Setting " + email + " stripeId to " + customer.id);

    await db.doc('users/' + userId).update(
        {
            stripeId: customer.id
        }
    )

    return customer.id;
}